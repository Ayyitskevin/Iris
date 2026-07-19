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
import {
  createReplicaRecoveryExport,
  parseReplicaRecoveryExport,
  replicaRecoveryExportFileName,
} from '../recovery/export';
import { replicaStorageKey } from './replica-repository';
import {
  assertReplicaRecoverySnapshot,
  parseReplicaRecoveryEnvelope,
  replicaRecoveryJournalOwnerKey,
  ReplicaRecoveryJournal,
  type ReplicaRecoveryEnvelope,
  type ReplicaRecoveryReason,
} from './replica-recovery-journal';
import {
  buildReplicaRecoveryCatalog,
  type PendingReplicaRecovery,
  type ReplicaRecoveryCatalog,
} from './replica-recovery-catalog';
import { assertReplicaSemanticIntegrity, ReplicaIntegrityError } from './replica-integrity';
import type { OwnerAuthorityHandle, OwnerAuthoritySnapshot } from './owner-replica-authority';
import { ownerReplicaRepository, ownerReplicaRuntime } from './select-owner-replica-repository';
import { ReplicaRepositoryStaleWriterError } from './transactional-replica-repository';
import { storage } from './storage';
export { ReplicaIntegrityError } from './replica-integrity';

export interface Session {
  token: string;
  userId: string;
  workspaceId: string;
  email: string;
  displayName: string;
}

export type SyncStatus =
  'idle' | 'syncing' | 'offline' | 'error' | 'auth-required' | 'recovery-required';

/** Ephemeral current-tab authority; never serialized into an owner replica. */
export type ReplicaAuthorityState = 'local' | 'acquiring' | 'leader' | 'follower' | 'unavailable';

export type SyncIssueRecoveryKind = 'rekey' | 'reset-cursor' | 'restage' | 'retry';

/**
 * A durable, owner-local sync hold. The coordinator does no network work while one
 * exists; only an explicit recovery action may clear or transform it.
 */
export interface SyncIssue {
  code: string;
  message: string;
  affectedOpIds: string[];
  recoveryKind: SyncIssueRecoveryKind;
}

export interface ReplicaState {
  notes: Record<string, Note>;
  syncCursor: string;
  deviceId: string;
  outbox: SyncMutation[];
  /** Exact request snapshot that must be replayed until its response is durably applied. */
  pendingPush: SyncMutation[] | null;
  syncIssue: SyncIssue | null;
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

/** Credential-free lease for owner-local recovery inspection and export only. */
export interface RecoveryInspectionLease {
  generation: number;
  ownerKey: string;
  userId: string;
  workspaceId: string;
  signal: AbortSignal;
}

export interface RecoveryInspectionVersion {
  readonly projection: number;
  readonly recovery: number;
}

export interface ReplicaRecoveryExportArtifact {
  catalog: ReplicaRecoveryCatalog;
  serializedExport: string;
  fileName: string;
  inspectionVersion: RecoveryInspectionVersion;
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
  replica: replicaStorageKey,
};

function blankState(status: SyncStatus = 'idle'): AppState {
  return {
    session: null,
    activeOwnerKey: null,
    notes: {},
    syncCursor: '',
    deviceId: '',
    outbox: [],
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
    status,
    syncGated: false,
  };
}

export const store$ = observable<AppState>(blankState());
export const replicaAuthority$ = observable<ReplicaAuthorityState>('local');
/** UI invalidation hint only; epoch assertions below remain the freshness authority. */
export const recoveryCatalogRevision$ = observable(0);

let generation = 0;
let generationController = new AbortController();
let projectionEpoch = 0;
const recoveryEpochs = new Map<string, number>();

function notifyRecoveryCatalogChanged(): void {
  recoveryCatalogRevision$.set(recoveryCatalogRevision$.get() + 1);
}

function advanceProjectionEpoch(): void {
  projectionEpoch += 1;
  notifyRecoveryCatalogChanged();
}

function advanceRecoveryEpoch(ownerKey: string): void {
  recoveryEpochs.set(ownerKey, (recoveryEpochs.get(ownerKey) ?? 0) + 1);
  notifyRecoveryCatalogChanged();
}
let sessionTransitioning = false;
let sessionRejected = false;
let sessionSaveQueue: Promise<void> = Promise.resolve();
let sessionTransitionQueue: Promise<void> = Promise.resolve();
let hydrationPromise: Promise<void> | null = null;
let pendingRejectedTombstone: string | null = null;

interface ReplicaAuthorityBinding {
  readonly ownerKey: string;
  readonly request: number;
  handle: OwnerAuthorityHandle | null;
  refreshVersion: number;
  refreshWaiters: Set<() => void>;
  refreshPromise: Promise<void> | null;
  refreshAgain: boolean;
}

let replicaAuthorityRequest = 0;
let replicaAuthorityBinding: ReplicaAuthorityBinding | null = null;
// A transactional repository read clears its stale-writer fence before the application can
// validate and publish the returned replica. Keep a second, owner-scoped fence for that whole
// recovery interval, and retain it when the bytes are absent or unreadable, so neither a
// re-entrant observer nor another edit can overwrite state this client cannot understand.
const authoritativeRecoveryFencedOwners = new Set<string>();
const authoritativeRecoveryPromises = new Map<string, Promise<PersistedReplica>>();
const replicaRecoveryJournal = new ReplicaRecoveryJournal(ownerReplicaRepository);
const pendingReplicaRecoveries = new Map<string, Map<string, ReplicaRecoveryReason>>();
interface AuthoritativeRecoveryBarrier {
  participants: number;
  failed: boolean;
  authoritativeValidated: boolean;
  authoritative: PersistedReplica | null;
}
const authoritativeRecoveryBarriers = new Map<string, AuthoritativeRecoveryBarrier>();

async function readReplicaRecoveryEnvelope(
  sourceOwnerKey: string,
): Promise<ReplicaRecoveryEnvelope | null> {
  if (!usesCoordinatedWebAuthority() || isOwnerReplicaWritable(sourceOwnerKey)) {
    return replicaRecoveryJournal.read(sourceOwnerKey);
  }
  const raw = await ownerReplicaRuntime.readFollower(
    replicaRecoveryJournalOwnerKey(sourceOwnerKey),
  );
  return raw === null ? null : parseReplicaRecoveryEnvelope(raw, sourceOwnerKey);
}

export class StaleSessionError extends Error {
  constructor() {
    super('Session changed while an operation was in flight');
    this.name = 'StaleSessionError';
  }
}

export class StaleRecoveryInspectionError extends Error {
  constructor() {
    super('Local recovery state changed while it was being inspected');
    this.name = 'StaleRecoveryInspectionError';
  }
}

export class StatePersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StatePersistenceError';
  }
}

/** The requested reducer did not commit because another writer advanced the owner root. */
export class ReplicaCommitSupersededError extends StatePersistenceError {
  constructor(ownerKey: string) {
    super(`Owner replica commit for ${ownerKey} was superseded by an authoritative writer`);
    this.name = 'ReplicaCommitSupersededError';
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
    pendingPush: null,
    syncIssue: null,
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
    pendingPush: replica.pendingPush ? [...replica.pendingPush] : null,
    syncIssue: replica.syncIssue
      ? { ...replica.syncIssue, affectedOpIds: [...replica.syncIssue.affectedOpIds] }
      : null,
    conflicts: { ...replica.conflicts },
  };
}

function assertReplicaIntegrity(replica: PersistedReplica): void {
  assertReplicaSemanticIntegrity(replica);
}

function parseReplica(raw: string, session: Session): PersistedReplica {
  const stored = JSON.parse(raw) as PersistedReplica & {
    pendingPush?: unknown;
    syncIssue?: unknown;
  };
  const parsed = {
    ...stored,
    // Replicas written before request staging shipped have no pendingPush field.
    pendingPush: stored.pendingPush === undefined ? null : stored.pendingPush,
    // Replicas written before terminal sync holds shipped have no syncIssue field.
    syncIssue: stored.syncIssue === undefined ? null : stored.syncIssue,
  } as PersistedReplica;
  assertReplicaRecoverySnapshot(ownerKeyFor(session), JSON.stringify(parsed));
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

function usesCoordinatedWebAuthority(): boolean {
  return ownerReplicaRuntime.mode === 'transactional-web';
}

function authorityStateFor(snapshot: OwnerAuthoritySnapshot): ReplicaAuthorityState {
  return usesCoordinatedWebAuthority() ? snapshot.role : 'local';
}

function isCurrentAuthorityBinding(binding: ReplicaAuthorityBinding): boolean {
  return (
    replicaAuthorityBinding === binding &&
    binding.request === replicaAuthorityRequest &&
    binding.ownerKey.length > 0
  );
}

function isOwnerReplicaWritable(ownerKey: string): boolean {
  if (!usesCoordinatedWebAuthority()) return true;
  const binding = replicaAuthorityBinding;
  return Boolean(
    binding &&
    isCurrentAuthorityBinding(binding) &&
    binding.ownerKey === ownerKey &&
    binding.handle?.snapshot().role === 'leader',
  );
}

export function replicaMutationsBlocked(): boolean {
  const authority = replicaAuthority$.get();
  return authority !== 'local' && authority !== 'leader';
}

export function selectReplicaAuthorityState(): ReplicaAuthorityState {
  return replicaAuthority$.get();
}

function assertOwnerReplicaAuthorityWritable(ownerKey: string): void {
  if (isOwnerReplicaWritable(ownerKey)) return;
  throw new StatePersistenceError(
    'This Iris tab does not hold write authority for the active owner replica',
  );
}

function notifyAuthorityRefreshWaiters(binding: ReplicaAuthorityBinding): void {
  binding.refreshVersion += 1;
  for (const resolve of binding.refreshWaiters) resolve();
  binding.refreshWaiters.clear();
}

function waitForAuthorityRefresh(
  binding: ReplicaAuthorityBinding,
  observedVersion: number,
  timeoutMs = 5000,
): Promise<boolean> {
  if (binding.refreshVersion !== observedVersion) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (refreshed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      binding.refreshWaiters.delete(onRefresh);
      resolve(refreshed);
    };
    const onRefresh = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    binding.refreshWaiters.add(onRefresh);
  });
}

async function readReplicaWithoutPromotion(ownerKey: string): Promise<string | null> {
  try {
    return await ownerReplicaRuntime.readFollower(ownerKey);
  } catch (cause) {
    throw new StatePersistenceError('Could not read the follower owner replica', { cause });
  }
}

function authoritySession(binding: ReplicaAuthorityBinding): Session | null {
  const session = store$.session.get();
  return session && ownerKeyFor(session) === binding.ownerKey ? session : null;
}

async function prepareReplicaAuthorityLeader(
  binding: ReplicaAuthorityBinding,
  snapshot: OwnerAuthoritySnapshot,
): Promise<void> {
  if (!isCurrentAuthorityBinding(binding) || snapshot.ownerKey !== binding.ownerKey) return;
  const session = authoritySession(binding);
  // Initial hydration owns no published session yet. `loadReplica` performs the required read
  // before activation. A rollback may still display the same owner while reacquiring; the new
  // handle is not installed yet, and its caller likewise performs an explicit authoritative read.
  if (!binding.handle || !session || store$.activeOwnerKey.get() !== binding.ownerKey) return;

  const raw = await readReplicaWithoutPromotion(binding.ownerKey);
  if (raw === null) {
    throw new StatePersistenceError(
      'The owner replica disappeared before this tab could take write authority',
    );
  }
  const replica = parseReplica(raw, session);
  if (
    !isCurrentAuthorityBinding(binding) ||
    binding.handle?.snapshot().epoch !== snapshot.epoch ||
    store$.activeOwnerKey.get() !== binding.ownerKey
  ) {
    throw new StaleSessionError();
  }
  publishReplicaProjection(replica);
}

async function performFollowerRefresh(binding: ReplicaAuthorityBinding): Promise<void> {
  do {
    binding.refreshAgain = false;
    const session = authoritySession(binding);
    const snapshot = binding.handle?.snapshot();
    if (
      !session ||
      !snapshot ||
      snapshot.role !== 'follower' ||
      store$.activeOwnerKey.get() !== binding.ownerKey
    ) {
      return;
    }
    const raw = await readReplicaWithoutPromotion(binding.ownerKey);
    if (raw === null) return;
    const replica = parseReplica(raw, session);
    const current = binding.handle?.snapshot();
    if (
      !isCurrentAuthorityBinding(binding) ||
      !current ||
      current.epoch !== snapshot.epoch ||
      current.role !== 'follower' ||
      store$.activeOwnerKey.get() !== binding.ownerKey
    ) {
      return;
    }
    publishReplicaProjection(replica);
  } while (binding.refreshAgain && isCurrentAuthorityBinding(binding));
}

function enqueueFollowerRefresh(binding: ReplicaAuthorityBinding): void {
  if (!isCurrentAuthorityBinding(binding)) return;
  notifyAuthorityRefreshWaiters(binding);
  if (binding.refreshPromise) {
    binding.refreshAgain = true;
    return;
  }
  const run = performFollowerRefresh(binding).catch(() => {
    if (isCurrentAuthorityBinding(binding) && store$.activeOwnerKey.get() === binding.ownerKey) {
      store$.status.set('error');
    }
  });
  binding.refreshPromise = run;
  void run.finally(() => {
    if (binding.refreshPromise === run) binding.refreshPromise = null;
  });
}

function applyReplicaAuthorityRole(
  binding: ReplicaAuthorityBinding,
  snapshot: OwnerAuthoritySnapshot,
): void {
  if (!isCurrentAuthorityBinding(binding) || snapshot.ownerKey !== binding.ownerKey) return;
  if (usesCoordinatedWebAuthority()) invalidateLeases();
  replicaAuthority$.set(authorityStateFor(snapshot));
  if (
    snapshot.role === 'unavailable' &&
    store$.activeOwnerKey.get() === binding.ownerKey &&
    !sessionTransitioning
  ) {
    store$.status.set('error');
  }
}

async function startReplicaAuthority(session: Session): Promise<void> {
  const ownerKey = ownerKeyFor(session);
  const request = ++replicaAuthorityRequest;
  const binding: ReplicaAuthorityBinding = {
    ownerKey,
    request,
    handle: null,
    refreshVersion: 0,
    refreshWaiters: new Set(),
    refreshPromise: null,
    refreshAgain: false,
  };
  replicaAuthorityBinding = binding;
  replicaAuthority$.set(usesCoordinatedWebAuthority() ? 'acquiring' : 'local');

  const handle = await ownerReplicaRuntime.authority.start(ownerKey, {
    prepareLeader: (snapshot) => prepareReplicaAuthorityLeader(binding, snapshot),
    onRole: (snapshot) => applyReplicaAuthorityRole(binding, snapshot),
    onRefresh: () => enqueueFollowerRefresh(binding),
  });
  if (!isCurrentAuthorityBinding(binding)) {
    await handle.close();
    throw new StaleSessionError();
  }
  binding.handle = handle;
  applyReplicaAuthorityRole(binding, handle.snapshot());
}

async function closeReplicaAuthority(): Promise<void> {
  const binding = replicaAuthorityBinding;
  replicaAuthorityRequest += 1;
  replicaAuthorityBinding = null;
  replicaAuthority$.set('local');
  if (!binding) return;
  for (const resolve of binding.refreshWaiters) resolve();
  binding.refreshWaiters.clear();
  await binding.handle?.close();
}

function publishReplicaAuthorityRefresh(ownerKey: string): void {
  if (!usesCoordinatedWebAuthority()) return;
  const binding = replicaAuthorityBinding;
  if (
    !binding ||
    !isCurrentAuthorityBinding(binding) ||
    binding.ownerKey !== ownerKey ||
    binding.handle?.snapshot().role !== 'leader'
  ) {
    return;
  }
  try {
    binding.handle.publishRefresh();
  } catch (cause) {
    // A verified replica commit remains a verified commit. The web driver synchronously moves to
    // `unavailable` and releases its lock when channel publication fails; do not misreport the
    // already-durable write as a storage failure. Unexpected handle failures still fail loud.
    if (binding.handle.snapshot().role !== 'unavailable') throw cause;
  }
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
    pendingPush: store$.pendingPush.get() ? [...store$.pendingPush.get()!] : null,
    syncIssue: store$.syncIssue.get()
      ? {
          ...store$.syncIssue.get()!,
          affectedOpIds: [...store$.syncIssue.get()!.affectedOpIds],
        }
      : null,
    conflicts: { ...store$.conflicts.get() },
  };
  assertReplicaIntegrity(replica);
  return replica;
}

function setOwnerPersistenceFailureStatus(ownerKey: string): void {
  if (store$.activeOwnerKey.get() !== ownerKey) return;
  store$.status.set(
    authoritativeRecoveryFencedOwners.has(ownerKey) ? 'recovery-required' : 'error',
  );
}

function assertAuthoritativeReplicaWritable(ownerKey: string): void {
  if (!authoritativeRecoveryFencedOwners.has(ownerKey)) return;
  throw new StatePersistenceError(
    'Could not persist the owner replica while authoritative recovery is fenced',
  );
}

async function enqueueReplicaSave(replica: PersistedReplica): Promise<void> {
  assertReplicaIntegrity(replica);
  const snapshot = cloneReplica(replica);
  assertAuthoritativeReplicaWritable(snapshot.ownerKey);
  assertOwnerReplicaAuthorityWritable(snapshot.ownerKey);
  const raw = JSON.stringify(snapshot);
  try {
    await ownerReplicaRepository.commit(snapshot.ownerKey, raw);
    publishReplicaAuthorityRefresh(snapshot.ownerKey);
  } catch (cause) {
    // Preserve the storage-level signal: the caller must validate and rehydrate the winner,
    // then report that this exact reducer was superseded rather than wrapping the conflict as
    // a generic backend failure.
    if (cause instanceof ReplicaRepositoryStaleWriterError) throw cause;
    throw new StatePersistenceError('Could not persist the owner replica', { cause });
  }
}

/**
 * Read and validate the winner after a stale compare-and-swap (ADR-017).
 *
 * Recovery is single-flight per owner. The application fence spans the queued repository read,
 * validation, and synchronous publication, and is retained on null, corrupt, foreign, or
 * future-version bytes. A valid winner may replace the active projection, but it never makes the
 * losing reducer successful: callers must still report supersession.
 */
function rehydrateAuthoritativeReplica(session: Session): Promise<PersistedReplica> {
  const ownerKey = ownerKeyFor(session);
  const recoveryInFlight = authoritativeRecoveryPromises.get(ownerKey);
  if (recoveryInFlight) return recoveryInFlight;

  fenceOwnerForAuthoritativeRecovery(ownerKey);
  const recovery = performAuthoritativeReplicaRehydration(session, ownerKey);
  // Keep the single-flight visible until every recovery participant has preserved its exact
  // candidate. Session departure must wait for that whole interval, not merely the owner read.
  authoritativeRecoveryPromises.set(ownerKey, recovery);
  return recovery;
}

async function performAuthoritativeReplicaRehydration(
  session: Session,
  ownerKey: string,
): Promise<PersistedReplica> {
  let authoritative: string | null;
  try {
    authoritative = await ownerReplicaRepository.read(ownerKey);
  } catch (cause) {
    throw new StatePersistenceError(
      'Could not read the authoritative replica after a stale-writer fence',
      { cause },
    );
  }
  if (authoritative === null) {
    throw new StatePersistenceError(
      'The authoritative owner replica disappeared after a stale-writer fence',
    );
  }

  let replica: PersistedReplica;
  try {
    replica = parseReplica(authoritative, session);
  } catch (cause) {
    throw new StatePersistenceError(
      'The authoritative owner replica is unreadable after a stale-writer fence',
      { cause },
    );
  }

  // Publication is deliberately deferred until the recovery barrier verifies that every
  // distinct losing candidate reached the append-only journal.
  return replica;
}

async function departureResultAfterAuthoritativeRecovery(
  fallback: PersistedReplica,
  recovery: Promise<PersistedReplica>,
): Promise<{ replica: PersistedReplica; superseded: boolean }> {
  try {
    const replica = await recovery;
    await flushPendingReplicaRecoveries(fallback.ownerKey);
    return { replica, superseded: true };
  } catch (recoveryError) {
    if (authoritativeRecoveryFencedOwners.has(fallback.ownerKey)) {
      await preserveReplicaRecovery(fallback, 'session-departure');
      return { replica: fallback, superseded: false };
    }
    throw recoveryError;
  }
}

/**
 * Persist an owner's final projection before leaving its session.
 *
 * A valid concurrent winner still aborts the transition so the user can see and retry from that
 * winner. If the winner is absent or unreadable, however, the application fence deliberately
 * prevents another write. Departure is allowed only after the exact token-free fallback is
 * verified in the append-only recovery journal, so neither the unreadable authority nor the last
 * readable local projection is overwritten or trapped behind an unwanted credential.
 */
async function persistReplicaBeforeSessionDeparture(
  session: Session,
  replica: PersistedReplica,
): Promise<{ replica: PersistedReplica; superseded: boolean }> {
  if (usesCoordinatedWebAuthority() && !isOwnerReplicaWritable(replica.ownerKey)) {
    return { replica, superseded: false };
  }
  const recoveryInFlight = authoritativeRecoveryPromises.get(replica.ownerKey);
  if (recoveryInFlight) {
    return departureResultAfterAuthoritativeRecovery(replica, recoveryInFlight);
  }
  if (authoritativeRecoveryFencedOwners.has(replica.ownerKey)) {
    await preserveReplicaRecovery(replica, 'session-departure');
    return { replica, superseded: false };
  }

  try {
    await enqueueReplicaSave(replica);
    return { replica, superseded: false };
  } catch (error) {
    if (!(error instanceof ReplicaRepositoryStaleWriterError)) throw error;
    return departureResultAfterAuthoritativeRecovery(
      replica,
      recoverFromStaleWriter(session, replica, 'session-departure'),
    );
  }
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
  advanceProjectionEpoch();
  const binding = replicaAuthorityBinding;
  replicaAuthority$.set(
    binding && binding.ownerKey === replica.ownerKey && binding.handle
      ? authorityStateFor(binding.handle.snapshot())
      : 'local',
  );
  const recoveryRequired = authoritativeRecoveryFencedOwners.has(replica.ownerKey);
  store$.set({
    session,
    activeOwnerKey: replica.ownerKey,
    notes: { ...replica.notes },
    syncCursor: replica.syncCursor,
    deviceId: replica.deviceId,
    outbox: [...replica.outbox],
    pendingPush: replica.pendingPush ? [...replica.pendingPush] : null,
    syncIssue: replica.syncIssue
      ? { ...replica.syncIssue, affectedOpIds: [...replica.syncIssue.affectedOpIds] }
      : null,
    conflicts: { ...replica.conflicts },
    status: recoveryRequired ? 'recovery-required' : 'idle',
    syncGated: false,
  });
}

async function compatibleRecoveryReplica(session: Session): Promise<PersistedReplica | null> {
  const ownerKey = ownerKeyFor(session);
  let recovery;
  try {
    recovery = await readReplicaRecoveryEnvelope(ownerKey);
  } catch (cause) {
    throw new StatePersistenceError('Could not read the owner recovery journal', { cause });
  }
  if (!recovery) return null;

  for (let index = recovery.snapshots.length - 1; index >= 0; index -= 1) {
    try {
      const replica = parseReplica(recovery.snapshots[index]!.serializedReplica, session);
      fenceOwnerForAuthoritativeRecovery(ownerKey);
      return replica;
    } catch {
      // Older compatible candidates remain eligible; every exact candidate stays in the journal.
    }
  }
  throw new StatePersistenceError('Owner recovery is required, but no compatible snapshot exists');
}

async function loadReplica(session: Session, allowCreate: boolean): Promise<PersistedReplica> {
  const ownerKey = ownerKeyFor(session);
  const hadPendingRecovery = Boolean(pendingReplicaRecoveries.get(ownerKey)?.size);
  if (hadPendingRecovery) {
    fenceOwnerForAuthoritativeRecovery(ownerKey);
    await flushPendingReplicaRecoveries(ownerKey);
  }

  let raw: string | null;
  const followerBinding = replicaAuthorityBinding;
  const followerRefreshVersion = followerBinding?.refreshVersion ?? 0;
  try {
    raw = isOwnerReplicaWritable(ownerKey)
      ? await ownerReplicaRepository.read(ownerKey)
      : await readReplicaWithoutPromotion(ownerKey);
    if (
      raw === null &&
      allowCreate &&
      usesCoordinatedWebAuthority() &&
      followerBinding?.ownerKey === ownerKey &&
      followerBinding.handle?.snapshot().role === 'follower'
    ) {
      if (
        followerBinding.refreshVersion !== followerRefreshVersion ||
        (await waitForAuthorityRefresh(followerBinding, followerRefreshVersion))
      ) {
        raw = await readReplicaWithoutPromotion(ownerKey);
      }
    }
  } catch (primaryCause) {
    // Transactional adapters validate the record envelope before returning its serialized root.
    // A corrupt or misrouted primary therefore rejects at the repository boundary; recovery must
    // still inspect the separately keyed journal instead of stopping before the fallback.
    try {
      const recovered = await compatibleRecoveryReplica(session);
      if (recovered) return recovered;
    } catch (recoveryCause) {
      throw new StatePersistenceError(
        'Could not read the owner replica or a compatible recovery snapshot',
        { cause: recoveryCause },
      );
    }
    throw new StatePersistenceError('Could not read the owner replica', { cause: primaryCause });
  }
  if (raw) {
    try {
      if (hadPendingRecovery) {
        const recovered = await compatibleRecoveryReplica(session);
        if (recovered) return recovered;
      }
      const replica = parseReplica(raw, session);
      authoritativeRecoveryFencedOwners.delete(ownerKey);
      return replica;
    } catch (cause) {
      const recovered = await compatibleRecoveryReplica(session);
      if (recovered) return recovered;
      throw cause;
    }
  }

  const recovered = await compatibleRecoveryReplica(session);
  if (recovered) return recovered;
  if (!allowCreate) {
    throw new StatePersistenceError(
      'Persisted session has no owner replica; refusing to create an empty replacement',
    );
  }
  if (!isOwnerReplicaWritable(ownerKey)) {
    throw new StatePersistenceError(
      'The active Iris tab has not created this owner replica yet; this tab remains read-only',
    );
  }

  authoritativeRecoveryFencedOwners.delete(ownerKey);
  const replica = emptyReplica(session);
  try {
    await enqueueReplicaSave(replica);
  } catch (error) {
    if (error instanceof ReplicaRepositoryStaleWriterError) {
      return recoverFromStaleWriter(session, replica, 'stale-writer');
    }
    throw error;
  }
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
    ? await ownerReplicaRepository.read(legacyOwnerKey)
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
    // With no verified migration marker, even a structurally valid v2 replica may be
    // the output of the unsafe partial migration. Quarantine it above, then rebuild
    // only from v1 records whose workspace ownership is explicit.
    const replicaRaw = JSON.stringify(replica);
    try {
      await ownerReplicaRepository.commit(replica.ownerKey, replicaRaw);
    } catch (cause) {
      throw new StatePersistenceError('Migrated replica could not be verified', { cause });
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
    await closeReplicaAuthority();
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
    let migratedLegacy = false;
    let followerLegacyReplica: PersistedReplica | null = null;
    const migrationComplete = isMigrationComplete(markerRaw);
    if (legacyRaw && !migrationComplete) {
      const legacy = JSON.parse(legacyRaw) as LegacyPersistedV1;
      const legacySession = isSession(legacy.session) ? legacy.session : null;
      if (legacySession) await startReplicaAuthority(legacySession);

      if (
        legacySession &&
        usesCoordinatedWebAuthority() &&
        !isOwnerReplicaWritable(ownerKeyFor(legacySession))
      ) {
        // The leader owns the one-time write/removal. This tab can still display the exact
        // attributable v1 projection until the leader publishes the migrated IndexedDB root.
        let keepStoredSession = false;
        let storedOwnerSession: Session | null = null;
        if (storedSessionRaw) {
          try {
            const stored = JSON.parse(storedSessionRaw) as unknown;
            if (isSession(stored)) {
              keepStoredSession = true;
              storedOwnerSession = stored;
            } else {
              keepStoredSession = isSessionTombstone(stored);
            }
          } catch {
            // A malformed partial v2 session does not suppress the attributable v1 owner.
          }
        }
        sessionRaw = keepStoredSession ? storedSessionRaw : JSON.stringify(legacySession);
        const projectionSession =
          storedOwnerSession && ownerKeyFor(storedOwnerSession) === ownerKeyFor(legacySession)
            ? storedOwnerSession
            : !keepStoredSession
              ? legacySession
              : null;
        if (projectionSession) followerLegacyReplica = safeLegacyReplica(legacy, projectionSession);
      } else {
        sessionRaw = await migrateLegacy(legacyRaw, storedSessionRaw);
        migratedLegacy = true;
        if (legacySession) publishReplicaAuthorityRefresh(ownerKeyFor(legacySession));
      }
    } else if (legacyRaw && migrationComplete) {
      void storage.remove(LEGACY_STATE_KEY).catch(() => undefined);
    }

    if (!sessionRaw) {
      await closeReplicaAuthority();
      return;
    }
    const session = JSON.parse(sessionRaw) as unknown;
    if (isSessionTombstone(session)) {
      await closeReplicaAuthority();
      sessionRejected = session.reason === 'rejected';
      store$.set(blankState(session.reason === 'rejected' ? 'auth-required' : 'idle'));
      return;
    }
    if (!isSession(session)) throw new ReplicaIntegrityError('Persisted session is invalid');
    if (replicaAuthorityBinding?.ownerKey !== ownerKeyFor(session)) {
      await closeReplicaAuthority();
      await startReplicaAuthority(session);
    }
    // A verified v1 migration may intentionally retain an already-active v2 session whose
    // owner root did not exist yet. That explicit conversion may materialize an empty root;
    // ordinary hydration stays fail-closed so missing authority cannot erase recovery.
    const replica =
      followerLegacyReplica?.ownerKey === ownerKeyFor(session)
        ? followerLegacyReplica
        : await loadReplica(session, migratedLegacy);
    activate(session, replica);
    publishReplicaAuthorityRefresh(replica.ownerKey);
  } catch {
    await closeReplicaAuthority();
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
  const session = store$.session.get();
  try {
    replica = snapshotActiveReplica();
  } catch {
    store$.status.set('error');
    return false;
  }
  if (!replica || !session) return true;
  if (usesCoordinatedWebAuthority() && !isOwnerReplicaWritable(replica.ownerKey)) return true;
  try {
    await enqueueReplicaSave(replica);
    return true;
  } catch (error) {
    if (error instanceof ReplicaRepositoryStaleWriterError) {
      try {
        await recoverFromStaleWriter(session, replica, 'stale-writer');
      } catch {
        setOwnerPersistenceFailureStatus(replica.ownerKey);
        return false;
      }
      setOwnerPersistenceFailureStatus(replica.ownerKey);
      return false;
    }
    setOwnerPersistenceFailureStatus(replica.ownerKey);
    return false;
  }
}

export function openSessionLease(): SessionLease | null {
  if (sessionTransitioning || sessionRejected) return null;
  const session = store$.session.get();
  const ownerKey = store$.activeOwnerKey.get();
  const deviceId = store$.deviceId.get();
  if (
    !session ||
    !ownerKey ||
    !deviceId ||
    ownerKey !== ownerKeyFor(session) ||
    !isOwnerReplicaWritable(ownerKey) ||
    authoritativeRecoveryFencedOwners.has(ownerKey)
  ) {
    return null;
  }
  return Object.freeze({
    ...session,
    generation,
    ownerKey,
    deviceId,
    signal: generationController.signal,
  });
}

export function openRecoveryInspectionLease(): RecoveryInspectionLease | null {
  if (sessionTransitioning || sessionRejected) return null;
  const session = store$.session.get();
  const ownerKey = store$.activeOwnerKey.get();
  if (!session || !ownerKey || ownerKey !== ownerKeyFor(session)) return null;
  return Object.freeze({
    generation,
    ownerKey,
    userId: session.userId,
    workspaceId: session.workspaceId,
    signal: generationController.signal,
  });
}

export function isCurrentRecoveryInspectionLease(lease: RecoveryInspectionLease): boolean {
  const session = store$.session.get();
  return Boolean(
    !lease.signal.aborted &&
    lease.generation === generation &&
    store$.activeOwnerKey.get() === lease.ownerKey &&
    session &&
    ownerKeyFor(session) === lease.ownerKey &&
    session.userId === lease.userId &&
    session.workspaceId === lease.workspaceId,
  );
}

export function assertCurrentRecoveryInspectionLease(lease: RecoveryInspectionLease): void {
  if (!isCurrentRecoveryInspectionLease(lease)) throw new StaleSessionError();
}

export function isCurrentSession(lease: SessionLease): boolean {
  const session = store$.session.get();
  return (
    !lease.signal.aborted &&
    lease.generation === generation &&
    store$.activeOwnerKey.get() === lease.ownerKey &&
    isOwnerReplicaWritable(lease.ownerKey) &&
    !authoritativeRecoveryFencedOwners.has(lease.ownerKey) &&
    store$.deviceId.get() === lease.deviceId &&
    session?.token === lease.token &&
    session.userId === lease.userId &&
    session.workspaceId === lease.workspaceId
  );
}

function isActiveSessionCredential(lease: SessionLease): boolean {
  const session = store$.session.get();
  return Boolean(
    session &&
    store$.activeOwnerKey.get() === lease.ownerKey &&
    ownerKeyFor(session) === lease.ownerKey &&
    session.token === lease.token &&
    session.userId === lease.userId &&
    session.workspaceId === lease.workspaceId,
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
    pendingPush: store$.pendingPush.get() ? [...store$.pendingPush.get()!] : null,
    syncIssue: store$.syncIssue.get()
      ? {
          ...store$.syncIssue.get()!,
          affectedOpIds: [...store$.syncIssue.get()!.affectedOpIds],
        }
      : null,
    conflicts: { ...store$.conflicts.get() },
  };
}

export interface ReplicaChange<Result> {
  next: ReplicaState;
  result: Result;
}

export interface AppliedReplicaChange<Result> {
  result: Result;
  /** Exact owner snapshot persistence; callers must handle this promise. */
  durable: Promise<void>;
}

interface InternalReplicaApplication<Result> extends AppliedReplicaChange<Result> {
  previous: PersistedReplica;
  next: PersistedReplica;
}

function persistedReplicaForLease(lease: SessionLease, state: ReplicaState): PersistedReplica {
  return {
    version: 2,
    ownerKey: lease.ownerKey,
    userId: lease.userId,
    workspaceId: lease.workspaceId,
    notes: { ...state.notes },
    syncCursor: state.syncCursor,
    deviceId: lease.deviceId,
    outbox: [...state.outbox],
    pendingPush: state.pendingPush ? [...state.pendingPush] : null,
    syncIssue: state.syncIssue
      ? { ...state.syncIssue, affectedOpIds: [...state.syncIssue.affectedOpIds] }
      : null,
    conflicts: { ...state.conflicts },
  };
}

function publishReplicaProjection(replica: PersistedReplica): void {
  advanceProjectionEpoch();
  const current = store$.get();
  store$.set({
    ...current,
    notes: { ...replica.notes },
    syncCursor: replica.syncCursor,
    deviceId: replica.deviceId,
    outbox: [...replica.outbox],
    pendingPush: replica.pendingPush ? [...replica.pendingPush] : null,
    syncIssue: replica.syncIssue
      ? { ...replica.syncIssue, affectedOpIds: [...replica.syncIssue.affectedOpIds] }
      : null,
    conflicts: { ...replica.conflicts },
  });
}

function activeProjectionMatches(lease: SessionLease, replica: PersistedReplica): boolean {
  return (
    isCurrentSession(lease) &&
    store$.syncCursor.get() === replica.syncCursor &&
    store$.deviceId.get() === replica.deviceId &&
    JSON.stringify(store$.notes.get()) === JSON.stringify(replica.notes) &&
    JSON.stringify(store$.outbox.get()) === JSON.stringify(replica.outbox) &&
    JSON.stringify(store$.pendingPush.get()) === JSON.stringify(replica.pendingPush) &&
    JSON.stringify(store$.syncIssue.get()) === JSON.stringify(replica.syncIssue) &&
    JSON.stringify(store$.conflicts.get()) === JSON.stringify(replica.conflicts)
  );
}

function applyReplicaChange<Result>(
  lease: SessionLease,
  update: (current: ReplicaState) => ReplicaChange<Result>,
): InternalReplicaApplication<Result> {
  assertCurrentSession(lease);
  assertAuthoritativeReplicaWritable(lease.ownerKey);
  const current = readReplicaForLease(lease);
  const change = update(current);
  const previous = persistedReplicaForLease(lease, current);
  const next = persistedReplicaForLease(lease, change.next);
  assertReplicaIntegrity(next);
  assertCurrentSession(lease);
  // Register durable ordering before the root publication. Legend-State observers run
  // synchronously and may re-enter this function with a newer local change; that newer
  // snapshot must queue after this one rather than be overwritten by it after restart.
  const durable = enqueueReplicaSave(next).then(
    () => assertCurrentSession(lease),
    async (error) => {
      // Rehydrate from the winner, then reject this exact reducer. A resolved durability
      // promise is reserved for a commit that actually reached the owner root.
      if (error instanceof ReplicaRepositoryStaleWriterError) {
        await recoverFromStaleWriter(lease, next, 'stale-writer');
        throw new ReplicaCommitSupersededError(lease.ownerKey);
      }
      throw error;
    },
  );
  publishReplicaProjection(next);
  return { result: change.result, durable, previous, next };
}

/**
 * Publish one synchronous local transaction and expose its exact durability promise.
 * Optimistic local edits stay visible on failure so a later commit can rescue them.
 */
export function applyReplicaForLease<Result>(
  lease: SessionLease,
  update: (current: ReplicaState) => ReplicaChange<Result>,
): AppliedReplicaChange<Result> {
  const { result, durable } = applyReplicaChange(lease, update);
  return { result, durable };
}

/** Replace and durably persist one current owner replica as one logical commit. */
export async function commitReplicaForLease<Result>(
  lease: SessionLease,
  update: (current: ReplicaState) => ReplicaChange<Result>,
): Promise<Result> {
  const applied = applyReplicaChange(lease, update);
  try {
    await applied.durable;
  } catch (error) {
    if (activeProjectionMatches(lease, applied.next)) publishReplicaProjection(applied.previous);
    throw error;
  }
  assertCurrentSession(lease);
  return applied.result;
}

/** Compatibility wrapper for reducers that do not return a value. */
export async function updateReplicaForLease(
  lease: SessionLease,
  update: (current: ReplicaState) => ReplicaState,
): Promise<void> {
  await commitReplicaForLease(lease, (current) => ({ next: update(current), result: undefined }));
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
    let priorReplica = snapshotActiveReplica();
    const priorSessionRaw = priorSession ? JSON.stringify(priorSession) : null;
    const priorOwnerKey = priorSession ? ownerKeyFor(priorSession) : null;
    const nextOwnerKey = ownerKeyFor(next);
    const authorityChanged = priorOwnerKey !== nextOwnerKey;
    let authoritySwitched = false;
    beginSessionTransition();

    try {
      if (priorReplica && priorSession) {
        const departure = await persistReplicaBeforeSessionDeparture(priorSession, priorReplica);
        priorReplica = departure.replica;
        if (departure.superseded) throw new ReplicaCommitSupersededError(priorReplica.ownerKey);
      }
      if (authorityChanged) {
        await closeReplicaAuthority();
        authoritySwitched = true;
      }
      if (replicaAuthorityBinding?.ownerKey !== nextOwnerKey) await startReplicaAuthority(next);
      const replica = await loadReplica(next, true);
      const raw = JSON.stringify(next);
      await persistSessionValue(raw);
      activate(next, replica);
      publishReplicaAuthorityRefresh(replica.ownerKey);
      sessionRejected = false;
      pendingRejectedTombstone = null;
    } catch (error) {
      let rollbackVerified = false;
      try {
        if (authoritySwitched) await closeReplicaAuthority();
        await persistSessionValue(priorSessionRaw);
        if (priorSession && priorReplica) {
          if (authoritySwitched && replicaAuthorityBinding?.ownerKey !== priorOwnerKey) {
            await startReplicaAuthority(priorSession);
          }
          if (authoritySwitched) priorReplica = await loadReplica(priorSession, false);
          activate(priorSession, priorReplica);
        }
        rollbackVerified = true;
      } catch {
        // Unknown durable state must never reactivate either account.
      }
      if (!rollbackVerified) {
        await closeReplicaAuthority();
        store$.set(blankState('error'));
      }
      if (!rollbackVerified) sessionRejected = true;
      if (priorReplica) setOwnerPersistenceFailureStatus(priorReplica.ownerKey);
      else store$.status.set('error');
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
    let replica = snapshotActiveReplica();
    const priorSessionRaw = priorSession ? JSON.stringify(priorSession) : null;
    beginSessionTransition();
    try {
      if (replica && priorSession) {
        const departure = await persistReplicaBeforeSessionDeparture(priorSession, replica);
        replica = departure.replica;
        if (departure.superseded) throw new ReplicaCommitSupersededError(replica.ownerKey);
      }
      await persistSessionValue(
        sessionTombstone('sign-out', priorSession ? ownerKeyFor(priorSession) : null),
      );
      await closeReplicaAuthority();
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
      if (replica) setOwnerPersistenceFailureStatus(replica.ownerKey);
      else store$.status.set('error');
      throw error;
    } finally {
      finishSessionTransition();
    }
  });
}

/** Expire only the exact active bearer; a recovery-stale lease may expire A, never B. */
export function expireSessionIfCurrent(lease: SessionLease): Promise<boolean> {
  return enqueueSessionTransition(async () => {
    // Recovery deliberately invalidates operation leases, but a 401 for the still-active exact
    // bearer must remain authoritative. Identity matching keeps a late A response from expiring B.
    if (!isCurrentSession(lease) && !isActiveSessionCredential(lease)) return false;
    sessionRejected = true;
    beginSessionTransition();
    let replica: PersistedReplica | null = null;
    try {
      replica = snapshotActiveReplica();
    } catch {
      // Integrity failure must not keep a server-rejected credential active.
    }
    let recoveryPreservationFailed = false;
    if (replica) {
      try {
        const departure = await persistReplicaBeforeSessionDeparture(lease, replica);
        replica = departure.replica;
      } catch {
        try {
          await preserveReplicaRecovery(replica, 'session-rejected');
        } catch {
          // Credential safety still wins for a server-rejected token. The transition throws
          // after tombstoning so callers can observe that local recovery was not also verified.
          recoveryPreservationFailed = true;
        }
      }
    }

    const rejectionTombstone = sessionTombstone('rejected', lease.ownerKey);
    store$.set(blankState('auth-required'));

    try {
      const credentialCleared = await persistRejectedCredential(rejectionTombstone);
      if (!credentialCleared) {
        pendingRejectedTombstone = rejectionTombstone;
        throw new StatePersistenceError(
          'Rejected session could not be cleared from durable storage',
        );
      }
      pendingRejectedTombstone = null;
      if (recoveryPreservationFailed) {
        throw new StatePersistenceError(
          'Rejected credential was cleared, but the local recovery snapshot could not be verified',
        );
      }
      return true;
    } finally {
      await closeReplicaAuthority();
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

function serializedReplicaForRecovery(replica: PersistedReplica): string {
  const snapshot = cloneReplica(replica);
  assertReplicaIntegrity(snapshot);
  return JSON.stringify(snapshot);
}

function stageReplicaRecovery(replica: PersistedReplica, reason: ReplicaRecoveryReason): void {
  const raw = serializedReplicaForRecovery(replica);
  let pending = pendingReplicaRecoveries.get(replica.ownerKey);
  if (!pending) {
    pending = new Map<string, ReplicaRecoveryReason>();
    pendingReplicaRecoveries.set(replica.ownerKey, pending);
  }
  if (!pending.has(raw)) {
    pending.set(raw, reason);
    advanceRecoveryEpoch(replica.ownerKey);
  }
}

async function flushPendingReplicaRecoveries(ownerKey: string): Promise<void> {
  try {
    while (true) {
      const pending = pendingReplicaRecoveries.get(ownerKey);
      const candidate = pending?.entries().next();
      if (!pending || !candidate || candidate.done) {
        pendingReplicaRecoveries.delete(ownerKey);
        return;
      }

      const [raw, reason] = candidate.value;
      await replicaRecoveryJournal.append(ownerKey, raw, reason);
      if (pendingReplicaRecoveries.get(ownerKey)?.get(raw) === reason) {
        pending.delete(raw);
        advanceRecoveryEpoch(ownerKey);
      }
    }
  } catch (cause) {
    throw new StatePersistenceError('Could not preserve the owner recovery journal', { cause });
  }
}

async function preserveReplicaRecovery(
  replica: PersistedReplica,
  reason: ReplicaRecoveryReason,
): Promise<void> {
  stageReplicaRecovery(replica, reason);
  await flushPendingReplicaRecoveries(replica.ownerKey);
}

function captureRecoveryInspectionEpochs(
  lease: RecoveryInspectionLease,
): RecoveryInspectionVersion {
  assertCurrentRecoveryInspectionLease(lease);
  return {
    projection: projectionEpoch,
    recovery: recoveryEpochs.get(lease.ownerKey) ?? 0,
  };
}

function assertRecoveryInspectionUnchanged(
  lease: RecoveryInspectionLease,
  epochs: RecoveryInspectionVersion,
): void {
  assertCurrentRecoveryInspectionLease(lease);
  if (
    projectionEpoch !== epochs.projection ||
    (recoveryEpochs.get(lease.ownerKey) ?? 0) !== epochs.recovery
  ) {
    throw new StaleRecoveryInspectionError();
  }
}

/** Recheck a completed local bundle immediately before and after platform delivery. */
export function isCurrentReplicaRecoveryExportArtifact(
  lease: RecoveryInspectionLease,
  artifact: ReplicaRecoveryExportArtifact,
): boolean {
  return Boolean(
    isCurrentRecoveryInspectionLease(lease) &&
    artifact.catalog.sourceOwnerKey === lease.ownerKey &&
    projectionEpoch === artifact.inspectionVersion.projection &&
    (recoveryEpochs.get(lease.ownerKey) ?? 0) === artifact.inspectionVersion.recovery,
  );
}

function pendingRecoverySnapshot(ownerKey: string): PendingReplicaRecovery[] {
  return [...(pendingReplicaRecoveries.get(ownerKey)?.entries() ?? [])].map(
    ([serializedReplica, reason]) => ({ serializedReplica, reason }),
  );
}

function displayedReplicaForRecoveryInspection(lease: RecoveryInspectionLease): string {
  assertCurrentRecoveryInspectionLease(lease);
  const replica = snapshotActiveReplica();
  if (!replica || replica.ownerKey !== lease.ownerKey) throw new StaleSessionError();
  return serializedReplicaForRecovery(replica);
}

/** Read every durable and current-process recovery candidate without committing state. */
export async function readReplicaRecoveryCatalogForLease(
  lease: RecoveryInspectionLease,
): Promise<ReplicaRecoveryCatalog | null> {
  return readReplicaRecoveryCatalogAttempt(lease, 1);
}

async function readReplicaRecoveryCatalogAttempt(
  lease: RecoveryInspectionLease,
  attempt: number,
): Promise<ReplicaRecoveryCatalog | null> {
  const epochs = captureRecoveryInspectionEpochs(lease);
  let envelope = null;
  let journalFailure: unknown;
  try {
    envelope = await readReplicaRecoveryEnvelope(lease.ownerKey);
  } catch (cause) {
    journalFailure = cause;
  }
  try {
    assertRecoveryInspectionUnchanged(lease, epochs);
  } catch (error) {
    if (
      error instanceof StaleRecoveryInspectionError &&
      isCurrentRecoveryInspectionLease(lease) &&
      projectionEpoch === epochs.projection &&
      attempt < 8
    ) {
      return readReplicaRecoveryCatalogAttempt(lease, attempt + 1);
    }
    throw error;
  }
  const pending = pendingRecoverySnapshot(lease.ownerKey);
  if (journalFailure && pending.length === 0) {
    throw new StatePersistenceError('Could not verify the owner recovery journal', {
      cause: journalFailure,
    });
  }
  const catalog = buildReplicaRecoveryCatalog({
    sourceOwnerKey: lease.ownerKey,
    envelope,
    pending,
    displayedSerializedReplica: displayedReplicaForRecoveryInspection(lease),
    inventoryComplete: !journalFailure,
  });
  try {
    assertRecoveryInspectionUnchanged(lease, epochs);
  } catch (error) {
    if (
      error instanceof StaleRecoveryInspectionError &&
      isCurrentRecoveryInspectionLease(lease) &&
      projectionEpoch === epochs.projection &&
      attempt < 8
    ) {
      return readReplicaRecoveryCatalogAttempt(lease, attempt + 1);
    }
    throw error;
  }
  return catalog;
}

/**
 * Flush already-staged candidates, then build a strict exact-byte local bundle.
 * The active owner root is never saved and no network client is involved.
 */
export async function createReplicaRecoveryExportForLease(
  lease: RecoveryInspectionLease,
  exportedAt: string = new Date().toISOString(),
): Promise<ReplicaRecoveryExportArtifact> {
  assertCurrentRecoveryInspectionLease(lease);
  await flushPendingReplicaRecoveries(lease.ownerKey);
  assertCurrentRecoveryInspectionLease(lease);
  if ((pendingReplicaRecoveries.get(lease.ownerKey)?.size ?? 0) > 0) {
    throw new StatePersistenceError('Recovery export is incomplete because a copy is not durable');
  }

  const epochs = captureRecoveryInspectionEpochs(lease);
  let envelope;
  try {
    envelope = await readReplicaRecoveryEnvelope(lease.ownerKey);
  } catch (cause) {
    throw new StatePersistenceError('Could not verify the owner recovery journal', { cause });
  }
  assertRecoveryInspectionUnchanged(lease, epochs);
  if (!envelope) throw new StatePersistenceError('No preserved recovery copies are available');

  const displayedSerializedReplica = displayedReplicaForRecoveryInspection(lease);
  const catalog = buildReplicaRecoveryCatalog({
    sourceOwnerKey: lease.ownerKey,
    envelope,
    pending: [],
    displayedSerializedReplica,
  });
  if (!catalog) throw new StatePersistenceError('No preserved recovery copies are available');
  const serializedExport = createReplicaRecoveryExport({
    envelope,
    displayedSerializedReplica,
    exportedAt,
  });
  parseReplicaRecoveryExport(serializedExport, lease.ownerKey);
  assertRecoveryInspectionUnchanged(lease, epochs);
  return Object.freeze({
    catalog,
    serializedExport,
    fileName: replicaRecoveryExportFileName(exportedAt),
    inspectionVersion: Object.freeze({ ...epochs }),
  });
}

function fenceOwnerForAuthoritativeRecovery(ownerKey: string): void {
  if (authoritativeRecoveryFencedOwners.has(ownerKey)) return;
  authoritativeRecoveryFencedOwners.add(ownerKey);
  if (store$.activeOwnerKey.get() === ownerKey && !sessionTransitioning) {
    invalidateLeases();
  }
}

function acquireAuthoritativeRecovery(ownerKey: string): AuthoritativeRecoveryBarrier {
  fenceOwnerForAuthoritativeRecovery(ownerKey);
  let barrier = authoritativeRecoveryBarriers.get(ownerKey);
  if (!barrier) {
    barrier = {
      participants: 0,
      failed: false,
      authoritativeValidated: false,
      authoritative: null,
    };
    authoritativeRecoveryBarriers.set(ownerKey, barrier);
  }
  barrier.participants += 1;
  return barrier;
}

function releaseAuthoritativeRecovery(
  ownerKey: string,
  barrier: AuthoritativeRecoveryBarrier,
  succeeded: boolean,
): void {
  if (!succeeded) barrier.failed = true;
  barrier.participants -= 1;
  if (barrier.participants > 0) return;

  if (!barrier.failed && barrier.authoritativeValidated && barrier.authoritative) {
    const activeSession = store$.session.get();
    // Publish while the application fence is still held so synchronous observers cannot
    // re-enter with an old lease between the winner projection and the fence release.
    if (
      activeSession &&
      store$.activeOwnerKey.get() === ownerKey &&
      ownerKeyFor(activeSession) === ownerKey
    ) {
      publishReplicaProjection(barrier.authoritative);
      store$.status.set('error');
    }
    authoritativeRecoveryFencedOwners.delete(ownerKey);
  } else {
    setOwnerPersistenceFailureStatus(ownerKey);
  }
  if (authoritativeRecoveryBarriers.get(ownerKey) === barrier) {
    authoritativeRecoveryBarriers.delete(ownerKey);
  }
  authoritativeRecoveryPromises.delete(ownerKey);
}

/**
 * Preserve the exact losing token-free root and validate the winner under one app fence.
 *
 * Several queued optimistic commits may lose the same repository revision. They share the
 * authoritative read, while the recovery journal serializes every distinct losing snapshot.
 * The fence clears only after all participants have durably preserved their candidate.
 */
async function recoverFromStaleWriter(
  session: Session,
  losingReplica: PersistedReplica,
  reason: ReplicaRecoveryReason,
): Promise<PersistedReplica> {
  const ownerKey = losingReplica.ownerKey;
  stageReplicaRecovery(losingReplica, reason);
  const barrier = acquireAuthoritativeRecovery(ownerKey);
  const authoritative = rehydrateAuthoritativeReplica(session);

  try {
    const [, winner] = await Promise.all([flushPendingReplicaRecoveries(ownerKey), authoritative]);
    barrier.authoritativeValidated = true;
    barrier.authoritative = winner;
    releaseAuthoritativeRecovery(ownerKey, barrier, true);
    return winner;
  } catch (error) {
    releaseAuthoritativeRecovery(ownerKey, barrier, false);
    throw error;
  }
}
