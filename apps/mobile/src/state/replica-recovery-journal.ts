import { assertSerializedReplicaOwner, type OwnerReplicaRepository } from './replica-repository';
import { ReplicaRepositoryStaleWriterError } from './transactional-replica-repository';

export const REPLICA_RECOVERY_JOURNAL_VERSION = 1 as const;
const RECOVERY_OWNER_PREFIX = 'iris.recovery-journal.v1.';
const RECOVERY_REPLICA_KEYS = [
  'conflicts',
  'deviceId',
  'notes',
  'outbox',
  'ownerKey',
  'pendingPush',
  'syncCursor',
  'syncIssue',
  'userId',
  'version',
  'workspaceId',
] as const;

export type ReplicaRecoveryReason = 'stale-writer' | 'session-departure' | 'session-rejected';

export interface ReplicaRecoverySnapshot {
  sequence: number;
  capturedAt: string;
  reason: ReplicaRecoveryReason;
  serializedReplica: string;
}

export interface ReplicaRecoveryEnvelope {
  version: typeof REPLICA_RECOVERY_JOURNAL_VERSION;
  ownerKey: string;
  sourceOwnerKey: string;
  snapshots: ReplicaRecoverySnapshot[];
}

export class ReplicaRecoveryJournalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReplicaRecoveryJournalError';
  }
}

/**
 * Domain-separate recovery records from UUID.UUID replica owners.
 *
 * The owner identifier is already part of the primary replica key; encoding it here avoids
 * delimiter ambiguity without pretending that a storage key is encryption.
 */
export function replicaRecoveryJournalOwnerKey(sourceOwnerKey: string): string {
  if (!sourceOwnerKey) {
    throw new ReplicaRecoveryJournalError('Recovery journal source owner is required');
  }
  return RECOVERY_OWNER_PREFIX + encodeURIComponent(sourceOwnerKey);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecoveryReason(value: unknown): value is ReplicaRecoveryReason {
  return value === 'stale-writer' || value === 'session-departure' || value === 'session-rejected';
}

const RECOVERY_CREDENTIAL_FIELD_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'session',
  'token',
]);

function assertNoCredentialFields(value: unknown): void {
  const candidates: unknown[] = [value];
  while (candidates.length > 0) {
    const candidate = candidates.pop();
    if (!candidate || typeof candidate !== 'object') continue;
    if (Array.isArray(candidate)) {
      candidates.push(...candidate);
      continue;
    }
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (RECOVERY_CREDENTIAL_FIELD_NAMES.has(normalized)) {
        throw new ReplicaRecoveryJournalError('Recovery snapshot contains a credential-like field');
      }
      candidates.push(nested);
    }
  }
}

const RECOVERY_NOTE_KEYS = [
  'bodyMd',
  'createdAt',
  'deletedAt',
  'folder',
  'id',
  'tags',
  'title',
  'updatedAt',
  'version',
  'workspaceId',
] as const;
const RECOVERY_MUTATION_KEYS = ['baseVersion', 'note', 'opId', 'type'] as const;
const RECOVERY_MUTATION_NOTE_KEYS = ['bodyMd', 'folder', 'id', 'tags', 'title'] as const;
const RECOVERY_SYNC_ISSUE_KEYS = ['affectedOpIds', 'code', 'message', 'recoveryKind'] as const;
const RECOVERY_CONFLICT_KEYS = ['detectedAt', 'localMutation', 'noteId', 'serverNote'] as const;

function strictRecord(
  value: unknown,
  expected: readonly string[],
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplicaRecoveryJournalError(`Recovery snapshot ${description} is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, expected)) {
    throw new ReplicaRecoveryJournalError(`Recovery snapshot ${description} has unexpected fields`);
  }
  return record;
}

function stringArray(value: unknown, description: string): value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ReplicaRecoveryJournalError(`Recovery snapshot ${description} is invalid`);
  }
  return true;
}

function assertRecoveryNote(value: unknown): void {
  const note = strictRecord(value, RECOVERY_NOTE_KEYS, 'note');
  if (
    typeof note.id !== 'string' ||
    typeof note.workspaceId !== 'string' ||
    typeof note.title !== 'string' ||
    typeof note.bodyMd !== 'string' ||
    (note.folder !== null && typeof note.folder !== 'string') ||
    !Number.isSafeInteger(note.version) ||
    (note.version as number) < 0 ||
    typeof note.createdAt !== 'string' ||
    typeof note.updatedAt !== 'string' ||
    (note.deletedAt !== null && typeof note.deletedAt !== 'string')
  ) {
    throw new ReplicaRecoveryJournalError('Recovery snapshot note values are invalid');
  }
  stringArray(note.tags, 'note tags');
}

function assertRecoveryMutation(value: unknown): void {
  const mutation = strictRecord(value, RECOVERY_MUTATION_KEYS, 'mutation');
  if (
    typeof mutation.opId !== 'string' ||
    !['upsert', 'delete', 'resurrect'].includes(mutation.type as string) ||
    !Number.isSafeInteger(mutation.baseVersion) ||
    (mutation.baseVersion as number) < 0
  ) {
    throw new ReplicaRecoveryJournalError('Recovery snapshot mutation values are invalid');
  }
  const note = strictRecord(mutation.note, RECOVERY_MUTATION_NOTE_KEYS, 'mutation note');
  if (
    typeof note.id !== 'string' ||
    typeof note.title !== 'string' ||
    typeof note.bodyMd !== 'string' ||
    (note.folder !== null && typeof note.folder !== 'string')
  ) {
    throw new ReplicaRecoveryJournalError('Recovery snapshot mutation note values are invalid');
  }
  stringArray(note.tags, 'mutation note tags');
}

function assertStrictNestedReplicaShape(parsed: Record<string, unknown>): void {
  if (typeof parsed.syncCursor !== 'string' || typeof parsed.deviceId !== 'string') {
    throw new ReplicaRecoveryJournalError('Recovery snapshot replica values are invalid');
  }

  const notes = parsed.notes;
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
    throw new ReplicaRecoveryJournalError('Recovery snapshot notes are invalid');
  }
  for (const [id, note] of Object.entries(notes as Record<string, unknown>)) {
    assertRecoveryNote(note);
    if ((note as Record<string, unknown>).id !== id) {
      throw new ReplicaRecoveryJournalError('Recovery snapshot note key is invalid');
    }
  }

  for (const queueName of ['outbox', 'pendingPush'] as const) {
    const queue = parsed[queueName];
    if (queueName === 'pendingPush' && queue === null) continue;
    if (!Array.isArray(queue)) {
      throw new ReplicaRecoveryJournalError(`Recovery snapshot ${queueName} is invalid`);
    }
    queue.forEach(assertRecoveryMutation);
  }

  if (parsed.syncIssue !== null) {
    const issue = strictRecord(parsed.syncIssue, RECOVERY_SYNC_ISSUE_KEYS, 'sync issue');
    if (
      typeof issue.code !== 'string' ||
      typeof issue.message !== 'string' ||
      !['rekey', 'reset-cursor', 'restage', 'retry'].includes(issue.recoveryKind as string)
    ) {
      throw new ReplicaRecoveryJournalError('Recovery snapshot sync issue values are invalid');
    }
    stringArray(issue.affectedOpIds, 'sync issue operation ids');
  }

  const conflicts = parsed.conflicts;
  if (!conflicts || typeof conflicts !== 'object' || Array.isArray(conflicts)) {
    throw new ReplicaRecoveryJournalError('Recovery snapshot conflicts are invalid');
  }
  for (const [id, value] of Object.entries(conflicts as Record<string, unknown>)) {
    const conflict = strictRecord(value, RECOVERY_CONFLICT_KEYS, 'conflict');
    if (conflict.noteId !== id || typeof conflict.detectedAt !== 'string') {
      throw new ReplicaRecoveryJournalError('Recovery snapshot conflict values are invalid');
    }
    assertRecoveryMutation(conflict.localMutation);
    assertRecoveryNote(conflict.serverNote);
  }
}

function assertTokenFreeReplica(sourceOwnerKey: string, serializedReplica: string): void {
  try {
    assertSerializedReplicaOwner(sourceOwnerKey, serializedReplica);
    const parsed = JSON.parse(serializedReplica) as Record<string, unknown>;
    if (
      !parsed ||
      Array.isArray(parsed) ||
      !exactKeys(parsed, RECOVERY_REPLICA_KEYS) ||
      parsed.version !== 2 ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.workspaceId !== 'string' ||
      parsed.ownerKey !== parsed.workspaceId + '.' + parsed.userId
    ) {
      throw new ReplicaRecoveryJournalError(
        'Recovery snapshot is not a strict credential-free owner replica',
      );
    }
    assertStrictNestedReplicaShape(parsed);
    assertNoCredentialFields(parsed);
  } catch (cause) {
    if (cause instanceof ReplicaRecoveryJournalError) throw cause;
    throw new ReplicaRecoveryJournalError('Recovery snapshot ownership is invalid', { cause });
  }
}

function freezeEnvelope(envelope: ReplicaRecoveryEnvelope): ReplicaRecoveryEnvelope {
  const snapshots = envelope.snapshots.map((snapshot) => Object.freeze({ ...snapshot }));
  return Object.freeze({
    ...envelope,
    snapshots: Object.freeze(snapshots),
  }) as ReplicaRecoveryEnvelope;
}

export function parseReplicaRecoveryEnvelope(
  raw: string,
  sourceOwnerKey: string,
): ReplicaRecoveryEnvelope {
  const recoveryOwnerKey = replicaRecoveryJournalOwnerKey(sourceOwnerKey);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ReplicaRecoveryJournalError('Recovery journal is not valid JSON', { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReplicaRecoveryJournalError('Recovery journal envelope is invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (
    !exactKeys(value, ['ownerKey', 'snapshots', 'sourceOwnerKey', 'version']) ||
    value.version !== REPLICA_RECOVERY_JOURNAL_VERSION ||
    value.ownerKey !== recoveryOwnerKey ||
    value.sourceOwnerKey !== sourceOwnerKey ||
    !Array.isArray(value.snapshots) ||
    value.snapshots.length === 0
  ) {
    throw new ReplicaRecoveryJournalError('Recovery journal ownership or shape is invalid');
  }

  const seen = new Set<string>();
  const snapshots = value.snapshots.map((candidate, index): ReplicaRecoverySnapshot => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ReplicaRecoveryJournalError('Recovery journal snapshot is invalid');
    }
    const snapshot = candidate as Record<string, unknown>;
    if (
      !exactKeys(snapshot, ['capturedAt', 'reason', 'sequence', 'serializedReplica']) ||
      snapshot.sequence !== index + 1 ||
      typeof snapshot.capturedAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
      new Date(snapshot.capturedAt).toISOString() !== snapshot.capturedAt ||
      !isRecoveryReason(snapshot.reason) ||
      typeof snapshot.serializedReplica !== 'string'
    ) {
      throw new ReplicaRecoveryJournalError('Recovery journal snapshot metadata is invalid');
    }
    assertTokenFreeReplica(sourceOwnerKey, snapshot.serializedReplica);
    if (seen.has(snapshot.serializedReplica)) {
      throw new ReplicaRecoveryJournalError('Recovery journal contains a duplicate snapshot');
    }
    seen.add(snapshot.serializedReplica);
    return {
      sequence: snapshot.sequence,
      capturedAt: snapshot.capturedAt,
      reason: snapshot.reason,
      serializedReplica: snapshot.serializedReplica,
    };
  });

  return freezeEnvelope({
    version: REPLICA_RECOVERY_JOURNAL_VERSION,
    ownerKey: recoveryOwnerKey,
    sourceOwnerKey,
    snapshots,
  });
}

/**
 * Append-only token-free recovery snapshots behind the same verified owner repository.
 *
 * The queue prevents this process from replacing a newer local append. Independent
 * transactional repository instances may still race; a stale CAS rereads, unions by exact
 * snapshot bytes, and retries without dropping either candidate.
 */
export class ReplicaRecoveryJournal {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: OwnerReplicaRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly maxAttempts = 8,
  ) {}

  read(sourceOwnerKey: string): Promise<ReplicaRecoveryEnvelope | null> {
    const pending = this.pending.get(sourceOwnerKey) ?? Promise.resolve();
    return pending.catch(() => undefined).then(() => this.readDirect(sourceOwnerKey));
  }

  append(
    sourceOwnerKey: string,
    serializedReplica: string,
    reason: ReplicaRecoveryReason,
  ): Promise<ReplicaRecoveryEnvelope> {
    try {
      assertTokenFreeReplica(sourceOwnerKey, serializedReplica);
    } catch (cause) {
      return Promise.reject(
        cause instanceof ReplicaRecoveryJournalError
          ? cause
          : new ReplicaRecoveryJournalError('Recovery snapshot is invalid', { cause }),
      );
    }

    const previous = this.pending.get(sourceOwnerKey) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => this.appendWithRetry(sourceOwnerKey, serializedReplica, reason));
    const completed = result.then(() => undefined);
    this.pending.set(sourceOwnerKey, completed);
    void completed.then(
      () => this.release(sourceOwnerKey, completed),
      () => this.release(sourceOwnerKey, completed),
    );
    return result;
  }

  private release(sourceOwnerKey: string, completed: Promise<void>): void {
    if (this.pending.get(sourceOwnerKey) === completed) this.pending.delete(sourceOwnerKey);
  }

  private async readDirect(sourceOwnerKey: string): Promise<ReplicaRecoveryEnvelope | null> {
    const raw = await this.repository.read(replicaRecoveryJournalOwnerKey(sourceOwnerKey));
    return raw === null ? null : parseReplicaRecoveryEnvelope(raw, sourceOwnerKey);
  }

  private async appendWithRetry(
    sourceOwnerKey: string,
    serializedReplica: string,
    reason: ReplicaRecoveryReason,
  ): Promise<ReplicaRecoveryEnvelope> {
    const recoveryOwnerKey = replicaRecoveryJournalOwnerKey(sourceOwnerKey);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const current = await this.readDirect(sourceOwnerKey);
      if (current?.snapshots.some((snapshot) => snapshot.serializedReplica === serializedReplica)) {
        return current;
      }

      const next = freezeEnvelope({
        version: REPLICA_RECOVERY_JOURNAL_VERSION,
        ownerKey: recoveryOwnerKey,
        sourceOwnerKey,
        snapshots: [
          ...(current?.snapshots ?? []),
          {
            sequence: (current?.snapshots.length ?? 0) + 1,
            capturedAt: this.now(),
            reason,
            serializedReplica,
          },
        ],
      });
      const raw = JSON.stringify(next);
      const verifiedNext = parseReplicaRecoveryEnvelope(raw, sourceOwnerKey);

      try {
        await this.repository.commit(recoveryOwnerKey, raw);
        return verifiedNext;
      } catch (cause) {
        if (cause instanceof ReplicaRepositoryStaleWriterError && attempt < this.maxAttempts) {
          continue;
        }
        throw new ReplicaRecoveryJournalError('Recovery journal append could not be verified', {
          cause,
        });
      }
    }

    throw new ReplicaRecoveryJournalError('Recovery journal append retry budget was exhausted');
  }
}
