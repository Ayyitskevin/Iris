/**
 * Owner-partitioned local-first state.
 *
 * The observable root is only the active projection. Durable replicas are stored under
 * an immutable workspace + user key, while the bearer credential is stored separately.
 * A monotonically increasing session generation fences every async operation.
 */
import { observable } from '@legendapp/state';
import type { Note, SyncMutation } from '@iris/shared';
import type { SyncConflictDraft } from '../sync/reconcile';
import { storage } from './storage';

export interface Session {
  token: string;
  userId: string;
  workspaceId: string;
  email: string;
  displayName: string;
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'auth-required';

export interface ReplicaState {
  notes: Record<string, Note>;
  syncCursor: string;
  deviceId: string;
  outbox: SyncMutation[];
  conflicts: Record<string, SyncConflictDraft>;
}

export interface AppState extends ReplicaState {
  session: Session | null;
  activeOwnerKey: string | null;
  status: SyncStatus;
  syncGated: boolean;
}

export interface SessionLease extends Session {
  generation: number;
  ownerKey: string;
  deviceId: string;
  signal: AbortSignal;
}

interface PersistedReplica extends ReplicaState {
  version: 2;
  ownerKey: string;
  userId: string;
  workspaceId: string;
}

interface LegacyPersistedV1 {
  session?: Session | null;
  notes?: Record<string, Note>;
  syncCursor?: string;
  deviceId?: string;
  outbox?: SyncMutation[];
  conflicts?: Record<string, SyncConflictDraft>;
}

interface LegacyRecovery {
  version: 1;
  recoveredAt: string;
  owner: Omit<Session, 'token'> | null;
  notes: Record<string, Note>;
  syncCursor: string;
  deviceId: string;
  outbox: SyncMutation[];
  conflicts: Record<string, SyncConflictDraft>;
  unmarkedReplica: { ownerKey: string; raw: string } | null;
}

interface SessionTombstone {
  version: 2;
  state: 'signed-out';
  reason: 'sign-out' | 'rejected';
  ownerKey: string | null;
  completedAt: string;
}

const LEGACY_STATE_KEY = 'iris:state:v1';
const SESSION_KEY = 'iris.session.v2';
const MIGRATION_KEY = 'iris.migration.v2';
const RECOVERY_KEY = 'iris.recovery.v1';

export const stateStorageKeys = {
  legacy: LEGACY_STATE_KEY,
  session: SESSION_KEY,
  migration: MIGRATION_KEY,
  recovery: RECOVERY_KEY,
  replica: (ownerKey: string) => 'iris.replica.v2.' + ownerKey,
};

function blankState(status: SyncStatus = 'idle'): AppState {
  return {
    session: null,
    activeOwnerKey: null,
    notes: {},
    syncCursor: '',
    deviceId: '',
    outbox: [],
    conflicts: {},
    status,
    syncGated: false,
  };
}

export const store$ = observable<AppState>(blankState());

let generation = 0;
let generationController = new AbortController();
let sessionTransitioning = false;
let sessionRejected = false;
const replicaSaveQueues = new Map<string, Promise<void>>();
let sessionSaveQueue: Promise<void> = Promise.resolve();
let sessionTransitionQueue: Promise<void> = Promise.resolve();
let hydrationPromise: Promise<void> | null = null;
let pendingRejectedTombstone: string | null = null;

export class StaleSessionError extends Error {
  constructor() {
    super('Session changed while an operation was in flight');
    this.name = 'StaleSessionError';
  }
}

export class StatePersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StatePersistenceError';
  }
}

export class ReplicaIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplicaIntegrityError';
  }
}

export function ownerKeyFor(owner: Pick<Session, 'workspaceId' | 'userId'>): string {
  return owner.workspaceId + '.' + owner.userId;
}

function generateDeviceId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return 'device-' + g.crypto.randomUUID();
  return 'device-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
}

function emptyReplica(session: Session, deviceId = generateDeviceId()): PersistedReplica {
  return {
    version: 2,
    ownerKey: ownerKeyFor(session),
    userId: session.userId,
    workspaceId: session.workspaceId,
    notes: {},
    syncCursor: '',
    deviceId,
    outbox: [],
    conflicts: {},
  };
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.token === 'string' &&
    v.token.length > 0 &&
    typeof v.userId === 'string' &&
    typeof v.workspaceId === 'string' &&
    typeof v.email === 'string' &&
    typeof v.displayName === 'string'
  );
}

function isSessionTombstone(value: unknown): value is SessionTombstone {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 2 &&
    v.state === 'signed-out' &&
    (v.reason === 'sign-out' || v.reason === 'rejected') &&
    (v.ownerKey === null || typeof v.ownerKey === 'string') &&
    typeof v.completedAt === 'string'
  );
}

function sessionTombstone(reason: SessionTombstone['reason'], ownerKey: string | null): string {
  return JSON.stringify({
    version: 2,
    state: 'signed-out',
    reason,
    ownerKey,
    completedAt: new Date().toISOString(),
  } satisfies SessionTombstone);
}

function isMigrationComplete(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return parsed.version === 2;
  } catch {
    return false;
  }
}

function cloneReplica(replica: PersistedReplica): PersistedReplica {
  return {
    ...replica,
    notes: { ...replica.notes },
    outbox: [...replica.outbox],
    conflicts: { ...replica.conflicts },
  };
}

function assertReplicaIntegrity(replica: PersistedReplica): void {
  if (
    replica.version !== 2 ||
    replica.ownerKey !== replica.workspaceId + '.' + replica.userId ||
    !replica.deviceId
  ) {
    throw new ReplicaIntegrityError('Replica owner metadata is invalid');
  }

  for (const [id, note] of Object.entries(replica.notes)) {
    if (id !== note.id || note.workspaceId !== replica.workspaceId) {
      throw new ReplicaIntegrityError('Replica contains a note owned by another workspace');
    }
  }
  for (const mutation of replica.outbox) {
    const note = replica.notes[mutation.note.id];
    if (!note || note.workspaceId !== replica.workspaceId) {
      throw new ReplicaIntegrityError('Replica outbox is not backed by an owned note');
    }
  }
  for (const [id, conflict] of Object.entries(replica.conflicts)) {
    if (
      id !== conflict.noteId ||
      conflict.serverNote.id !== id ||
      conflict.serverNote.workspaceId !== replica.workspaceId ||
      conflict.localMutation.note.id !== id
    ) {
      throw new ReplicaIntegrityError('Replica conflict is not owned by this workspace');
    }
  }
}

function parseReplica(raw: string, session: Session): PersistedReplica {
  const parsed = JSON.parse(raw) as PersistedReplica;
  assertReplicaIntegrity(parsed);
  if (
    parsed.ownerKey !== ownerKeyFor(session) ||
    parsed.userId !== session.userId ||
    parsed.workspaceId !== session.workspaceId
  ) {
    throw new ReplicaIntegrityError('Replica does not match the active session owner');
  }
  return parsed;
}

function snapshotActiveReplica(): PersistedReplica | null {
  const session = store$.session.get();
  const ownerKey = store$.activeOwnerKey.get();
  if (!session || !ownerKey || ownerKey !== ownerKeyFor(session)) return null;

  const replica: PersistedReplica = {
    version: 2,
    ownerKey,
    userId: session.userId,
    workspaceId: session.workspaceId,
    notes: { ...store$.notes.get() },
    syncCursor: store$.syncCursor.get(),
    deviceId: store$.deviceId.get(),
    outbox: [...store$.outbox.get()],
    conflicts: { ...store$.conflicts.get() },
  };
  assertReplicaIntegrity(replica);
  return replica;
}

function enqueueReplicaSave(replica: PersistedReplica): Promise<void> {
  assertReplicaIntegrity(replica);
  const snapshot = cloneReplica(replica);
  const raw = JSON.stringify(snapshot);
  const previous = replicaSaveQueues.get(replica.ownerKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const key = stateStorageKeys.replica(snapshot.ownerKey);
      let operationError: unknown;
      try {
        await storage.set(key, raw);
      } catch (error) {
        operationError = error;
      }
      try {
        if ((await storage.get(key)) !== raw) {
          throw new StatePersistenceError('Owner replica write could not be verified');
        }
      } catch (cause) {
        throw new StatePersistenceError('Could not persist the owner replica', {
          cause: operationError ?? cause,
        });
      }
    });
  replicaSaveQueues.set(replica.ownerKey, next);
  return next;
}

function enqueueSessionWrite(task: () => Promise<void>): Promise<void> {
  sessionSaveQueue = sessionSaveQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await task();
      } catch (cause) {
        throw new StatePersistenceError('Could not persist the session transition', { cause });
      }
    });
  return sessionSaveQueue;
}

async function persistSessionStorageValue(
  key: string,
  raw: string | null,
  description: string,
): Promise<void> {
  await enqueueSessionWrite(async () => {
    let operationError: unknown;
    try {
      if (raw === null) await storage.remove(key);
      else await storage.set(key, raw);
    } catch (error) {
      operationError = error;
    }

    let observed: string | null;
    try {
      observed = await storage.get(key);
    } catch (cause) {
      throw new StatePersistenceError('Could not verify ' + description, {
        cause: operationError ?? cause,
      });
    }
    if (observed !== raw) {
      throw new StatePersistenceError(description + ' did not reach durable storage', {
        cause: operationError,
      });
    }
  });
}

function persistSessionValue(raw: string | null): Promise<void> {
  return persistSessionStorageValue(SESSION_KEY, raw, 'Session transition');
}

async function persistRejectedCredential(tombstone: string): Promise<boolean> {
  try {
    await persistSessionValue(tombstone);
    return true;
  } catch {
    try {
      await persistSessionValue(null);
      return true;
    } catch {
      return false;
    }
  }
}

function enqueueSessionTransition<T>(transition: () => Promise<T>): Promise<T> {
  const run = sessionTransitionQueue.catch(() => undefined).then(transition);
  sessionTransitionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function beginSessionTransition(): void {
  if (sessionTransitioning) {
    throw new StatePersistenceError('Another session transition is already in progress');
  }
  sessionTransitioning = true;
  invalidateLeases();
}

function finishSessionTransition(): void {
  sessionTransitioning = false;
}

function invalidateLeases(): number {
  generationController.abort();
  generation += 1;
  generationController = new AbortController();
  return generation;
}

function activate(session: Session, replica: PersistedReplica): void {
  assertReplicaIntegrity(replica);
  store$.set({
    session,
    activeOwnerKey: replica.ownerKey,
    notes: { ...replica.notes },
    syncCursor: replica.syncCursor,
    deviceId: replica.deviceId,
    outbox: [...replica.outbox],
    conflicts: { ...replica.conflicts },
    status: 'idle',
    syncGated: false,
  });
}

async function loadReplica(session: Session): Promise<PersistedReplica> {
  const ownerKey = ownerKeyFor(session);
  await (replicaSaveQueues.get(ownerKey) ?? Promise.resolve()).catch(() => undefined);

  const raw = await storage.get(stateStorageKeys.replica(ownerKey));
  const replica = raw ? parseReplica(raw, session) : emptyReplica(session);
  if (!raw) await enqueueReplicaSave(replica);
  return replica;
}

function safeLegacyReplica(legacy: LegacyPersistedV1, session: Session): PersistedReplica {
  const legacyNotes = legacy.notes ?? {};
  const notes: Record<string, Note> = {};

  for (const [id, note] of Object.entries(legacyNotes)) {
    if (id !== note.id) continue;
    if (note.workspaceId === session.workspaceId) notes[id] = note;
  }

  const outbox = (legacy.outbox ?? []).filter((mutation) => Boolean(notes[mutation.note.id]));
  const conflicts: Record<string, SyncConflictDraft> = {};
  for (const [id, conflict] of Object.entries(legacy.conflicts ?? {})) {
    if (
      notes[id] &&
      conflict.noteId === id &&
      conflict.localMutation.note.id === id &&
      conflict.serverNote.id === id &&
      conflict.serverNote.workspaceId === session.workspaceId
    ) {
      conflicts[id] = conflict;
    }
  }

  return {
    ...emptyReplica(session),
    notes,
    outbox,
    conflicts,
    // V1 cursors and device ids were global. They have no trustworthy owner provenance.
    syncCursor: '',
  };
}

async function migrateLegacy(
  raw: string,
  existingSessionRaw: string | null,
): Promise<string | null> {
  const legacy = JSON.parse(raw) as LegacyPersistedV1;
  const legacySession = isSession(legacy.session) ? legacy.session : null;
  const legacyOwnerKey = legacySession ? ownerKeyFor(legacySession) : null;
  const unmarkedReplicaRaw = legacyOwnerKey
    ? await storage.get(stateStorageKeys.replica(legacyOwnerKey))
    : null;
  const recovery: LegacyRecovery = {
    version: 1,
    recoveredAt: new Date().toISOString(),
    owner: legacySession
      ? {
          userId: legacySession.userId,
          workspaceId: legacySession.workspaceId,
          email: legacySession.email,
          displayName: legacySession.displayName,
        }
      : null,
    notes: legacy.notes ?? {},
    syncCursor: legacy.syncCursor ?? '',
    deviceId: legacy.deviceId ?? '',
    outbox: legacy.outbox ?? [],
    conflicts: legacy.conflicts ?? {},
    unmarkedReplica:
      legacyOwnerKey && unmarkedReplicaRaw
        ? { ownerKey: legacyOwnerKey, raw: unmarkedReplicaRaw }
        : null,
  };
  const recoveryRaw = JSON.stringify(recovery);
  await storage.set(RECOVERY_KEY, recoveryRaw);
  if ((await storage.get(RECOVERY_KEY)) !== recoveryRaw) {
    throw new StatePersistenceError('Legacy recovery copy could not be verified');
  }

  let existingSession: Session | null = null;
  let existingTombstone = false;
  if (existingSessionRaw) {
    try {
      const parsed = JSON.parse(existingSessionRaw) as unknown;
      if (isSession(parsed)) existingSession = parsed;
      else if (isSessionTombstone(parsed)) existingTombstone = true;
    } catch {
      // A malformed partial v2 credential cannot suppress a valid v1 owner recovery.
    }
  }

  let sessionRaw = existingSession
    ? JSON.stringify(existingSession)
    : existingTombstone
      ? existingSessionRaw
      : null;
  if (legacySession) {
    const replica = safeLegacyReplica(legacy, legacySession);
    const replicaKey = stateStorageKeys.replica(replica.ownerKey);
    // With no verified migration marker, even a structurally valid v2 replica may be
    // the output of the unsafe partial migration. Quarantine it above, then rebuild
    // only from v1 records whose workspace ownership is explicit.
    const replicaRaw = JSON.stringify(replica);
    await storage.set(replicaKey, replicaRaw);
    if ((await storage.get(replicaKey)) !== replicaRaw) {
      throw new StatePersistenceError('Migrated replica could not be verified');
    }

    if (!existingSession && !existingTombstone) {
      sessionRaw = JSON.stringify(legacySession);
      await persistSessionValue(sessionRaw);
    }
  } else if (!existingSession && !existingTombstone && existingSessionRaw) {
    await persistSessionValue(null);
  }

  const markerRaw = JSON.stringify({ version: 2, completedAt: new Date().toISOString() });
  await storage.set(MIGRATION_KEY, markerRaw);
  if ((await storage.get(MIGRATION_KEY)) !== markerRaw) {
    throw new StatePersistenceError('Migration marker could not be verified');
  }

  try {
    await storage.remove(LEGACY_STATE_KEY);
  } catch {
    // The verified marker makes a leftover v1 blob inert; cleanup retries next boot.
  }
  return sessionRaw;
}

async function hydrateState(): Promise<void> {
  beginSessionTransition();
  store$.set(blankState());
  sessionRejected = false;
  try {
    if (pendingRejectedTombstone) {
      if (await persistRejectedCredential(pendingRejectedTombstone)) {
        pendingRejectedTombstone = null;
      } else {
        sessionRejected = true;
        store$.set(blankState('auth-required'));
        return;
      }
    }

    const [markerRaw, legacyRaw, storedSessionRaw] = await Promise.all([
      storage.get(MIGRATION_KEY),
      storage.get(LEGACY_STATE_KEY),
      storage.get(SESSION_KEY),
    ]);
    let sessionRaw = storedSessionRaw;
    const migrationComplete = isMigrationComplete(markerRaw);
    if (legacyRaw && !migrationComplete) {
      sessionRaw = await migrateLegacy(legacyRaw, storedSessionRaw);
    } else if (legacyRaw && migrationComplete) {
      void storage.remove(LEGACY_STATE_KEY).catch(() => undefined);
    }

    if (!sessionRaw) return;
    const session = JSON.parse(sessionRaw) as unknown;
    if (isSessionTombstone(session)) {
      sessionRejected = session.reason === 'rejected';
      store$.set(blankState(session.reason === 'rejected' ? 'auth-required' : 'idle'));
      return;
    }
    if (!isSession(session)) throw new ReplicaIntegrityError('Persisted session is invalid');
    const replica = await loadReplica(session);
    activate(session, replica);
  } catch {
    store$.set(blankState('error'));
  } finally {
    finishSessionTransition();
  }
}

/** Hydrate once at a time, serialized with every account transition. */
export function loadState(): Promise<void> {
  if (hydrationPromise) return hydrationPromise;
  const run = enqueueSessionTransition(hydrateState);
  hydrationPromise = run;
  void run.then(
    () => {
      if (hydrationPromise === run) hydrationPromise = null;
    },
    () => {
      if (hydrationPromise === run) hydrationPromise = null;
    },
  );
  return run;
}

/** Persist the current owner projection without ever writing the credential into it. */
export async function saveState(): Promise<boolean> {
  let replica: PersistedReplica | null;
  try {
    replica = snapshotActiveReplica();
  } catch {
    store$.status.set('error');
    return false;
  }
  if (!replica) return true;
  try {
    await enqueueReplicaSave(replica);
    return true;
  } catch {
    if (store$.activeOwnerKey.get() === replica.ownerKey) store$.status.set('error');
    return false;
  }
}

export function openSessionLease(): SessionLease | null {
  if (sessionTransitioning || sessionRejected) return null;
  const session = store$.session.get();
  const ownerKey = store$.activeOwnerKey.get();
  const deviceId = store$.deviceId.get();
  if (!session || !ownerKey || !deviceId || ownerKey !== ownerKeyFor(session)) return null;
  return Object.freeze({
    ...session,
    generation,
    ownerKey,
    deviceId,
    signal: generationController.signal,
  });
}

export function isCurrentSession(lease: SessionLease): boolean {
  const session = store$.session.get();
  return (
    !lease.signal.aborted &&
    lease.generation === generation &&
    store$.activeOwnerKey.get() === lease.ownerKey &&
    store$.deviceId.get() === lease.deviceId &&
    session?.token === lease.token &&
    session.userId === lease.userId &&
    session.workspaceId === lease.workspaceId
  );
}

export function assertCurrentSession(lease: SessionLease): void {
  if (!isCurrentSession(lease)) throw new StaleSessionError();
}

export function readReplicaForLease(lease: SessionLease): ReplicaState {
  assertCurrentSession(lease);
  return {
    notes: { ...store$.notes.get() },
    syncCursor: store$.syncCursor.get(),
    deviceId: store$.deviceId.get(),
    outbox: [...store$.outbox.get()],
    conflicts: { ...store$.conflicts.get() },
  };
}

/** Replace and durably persist one current owner replica as one JSON commit. */
export async function updateReplicaForLease(
  lease: SessionLease,
  update: (current: ReplicaState) => ReplicaState,
): Promise<void> {
  const current = readReplicaForLease(lease);
  const next = update(current);
  const replica: PersistedReplica = {
    version: 2,
    ownerKey: lease.ownerKey,
    userId: lease.userId,
    workspaceId: lease.workspaceId,
    notes: { ...next.notes },
    syncCursor: next.syncCursor,
    deviceId: lease.deviceId,
    outbox: [...next.outbox],
    conflicts: { ...next.conflicts },
  };
  const previousReplica: PersistedReplica = {
    version: 2,
    ownerKey: lease.ownerKey,
    userId: lease.userId,
    workspaceId: lease.workspaceId,
    notes: { ...current.notes },
    syncCursor: current.syncCursor,
    deviceId: lease.deviceId,
    outbox: [...current.outbox],
    conflicts: { ...current.conflicts },
  };
  assertReplicaIntegrity(replica);
  assertCurrentSession(lease);
  store$.notes.set(replica.notes);
  store$.syncCursor.set(replica.syncCursor);
  store$.outbox.set(replica.outbox);
  store$.conflicts.set(replica.conflicts);
  try {
    await enqueueReplicaSave(replica);
  } catch (error) {
    const unchangedSinceApply =
      isCurrentSession(lease) &&
      store$.syncCursor.get() === replica.syncCursor &&
      JSON.stringify(store$.notes.get()) === JSON.stringify(replica.notes) &&
      JSON.stringify(store$.outbox.get()) === JSON.stringify(replica.outbox) &&
      JSON.stringify(store$.conflicts.get()) === JSON.stringify(replica.conflicts);
    if (unchangedSinceApply) {
      store$.notes.set(previousReplica.notes);
      store$.syncCursor.set(previousReplica.syncCursor);
      store$.outbox.set(previousReplica.outbox);
      store$.conflicts.set(previousReplica.conflicts);
    }
    throw error;
  }
  assertCurrentSession(lease);
}

export function setStatusForLease(lease: SessionLease, status: SyncStatus): void {
  assertCurrentSession(lease);
  store$.status.set(status);
}

export function setSyncGatedForLease(lease: SessionLease, gated: boolean): void {
  assertCurrentSession(lease);
  store$.syncGated.set(gated);
}

/** Preserve the old projection, then atomically reveal only the new owner's replica. */
export function adoptSession(next: Session): Promise<void> {
  return enqueueSessionTransition(async () => {
    const priorSession = store$.session.get();
    const priorReplica = snapshotActiveReplica();
    const priorSessionRaw = priorSession ? JSON.stringify(priorSession) : null;
    beginSessionTransition();

    try {
      if (priorReplica) await enqueueReplicaSave(priorReplica);
      const replica = await loadReplica(next);
      const raw = JSON.stringify(next);
      await persistSessionValue(raw);
      activate(next, replica);
      sessionRejected = false;
      pendingRejectedTombstone = null;
    } catch (error) {
      let rollbackVerified = false;
      try {
        await persistSessionValue(priorSessionRaw);
        rollbackVerified = true;
      } catch {
        // Unknown durable state must never reactivate either account.
      }
      if (rollbackVerified && priorSession && priorReplica) activate(priorSession, priorReplica);
      else store$.set(blankState('error'));
      if (!rollbackVerified) sessionRejected = true;
      store$.status.set('error');
      throw error;
    } finally {
      finishSessionTransition();
    }
  });
}

/** Sign out locally while retaining every draft in the owner's private replica. */
export function signOutSession(): Promise<void> {
  return enqueueSessionTransition(async () => {
    const priorSession = store$.session.get();
    const replica = snapshotActiveReplica();
    const priorSessionRaw = priorSession ? JSON.stringify(priorSession) : null;
    beginSessionTransition();
    try {
      if (replica) await enqueueReplicaSave(replica);
      await persistSessionValue(
        sessionTombstone('sign-out', priorSession ? ownerKeyFor(priorSession) : null),
      );
      store$.set(blankState());
      sessionRejected = false;
      pendingRejectedTombstone = null;
    } catch (error) {
      let rollbackVerified = false;
      try {
        await persistSessionValue(priorSessionRaw);
        rollbackVerified = true;
      } catch {
        // Unknown durable state must remain fenced instead of appearing signed out.
      }
      if (rollbackVerified && priorSession && replica) activate(priorSession, replica);
      else {
        sessionRejected = true;
        store$.set(blankState('error'));
      }
      store$.status.set('error');
      throw error;
    } finally {
      finishSessionTransition();
    }
  });
}

/** Expire only the exact current lease; a late A 401 can never sign B out. */
export function expireSessionIfCurrent(lease: SessionLease): Promise<boolean> {
  return enqueueSessionTransition(async () => {
    if (!isCurrentSession(lease)) return false;
    sessionRejected = true;
    beginSessionTransition();
    let replica: PersistedReplica | null = null;
    try {
      replica = snapshotActiveReplica();
    } catch {
      // Integrity failure must not keep a server-rejected credential active.
    }
    const rejectionTombstone = sessionTombstone('rejected', lease.ownerKey);
    store$.set(blankState('auth-required'));

    try {
      const credentialCleared = await persistRejectedCredential(rejectionTombstone);

      try {
        if (replica) await enqueueReplicaSave(replica);
      } catch {
        // A rejected credential must still be cleared; the last committed replica remains.
      }

      if (!credentialCleared) {
        pendingRejectedTombstone = rejectionTombstone;
        throw new StatePersistenceError(
          'Rejected session could not be cleared from durable storage',
        );
      }
      pendingRejectedTombstone = null;
      return true;
    } finally {
      finishSessionTransition();
    }
  });
}

/** Retry a current-process 401 tombstone after a temporary storage outage. */
export function retryPendingSessionPersistence(): Promise<boolean> {
  return enqueueSessionTransition(async () => {
    const tombstone = pendingRejectedTombstone;
    if (!tombstone) return true;
    if (await persistRejectedCredential(tombstone)) {
      if (pendingRejectedTombstone === tombstone) pendingRejectedTombstone = null;
      return true;
    }
    return false;
  });
}

/** Sorted, non-deleted notes for list rendering. */
export function selectVisibleNotes(): Note[] {
  return Object.values(store$.notes.get())
    .filter((note) => !note.deletedAt)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Distinct tags across visible notes, with counts — powers the filter chips. */
export function selectTags(): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of selectVisibleNotes()) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
