/**
 * Digest-only write-ahead evidence for the default-off legacy -> transactional cutover.
 *
 * Exact replica bytes stay in their source repositories or in ReplicaRecoveryJournal. This
 * control record stores only domain-separated SHA-256 digests and legal state transitions, so a
 * current client can detect an old runtime changing the legacy key without pretending it can
 * prevent that write.
 */
import { type OwnerReplicaRepository } from './replica-repository';
import { ReplicaRepositoryStaleWriterError } from './transactional-replica-repository';

export const REPLICA_DIVERGENCE_JOURNAL_VERSION = 1 as const;
export const REPLICA_ROOT_DIGEST_DOMAIN = 'iris.owner-replica.v2.exact-bytes';
export const MAX_REPLICA_DIVERGENCE_ENTRIES = 64;
const DIVERGENCE_OWNER_PREFIX = 'iris.replica-divergence.v1.';
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type ReplicaDivergenceState = 'preparing' | 'transactional' | 'diverged';
export type ReplicaDivergenceReason =
  | 'promotion'
  | 'commit'
  | 'adopt-existing'
  | 'resume'
  | 'checkpoint'
  | 'legacy-drift'
  | 'primary-drift';

export interface AbsentReplicaRootDigest {
  readonly kind: 'absent';
}

export interface PresentReplicaRootDigest {
  readonly kind: 'sha256';
  readonly algorithm: 'SHA-256';
  readonly domain: typeof REPLICA_ROOT_DIGEST_DOMAIN;
  readonly hex: string;
}

export type ReplicaRootDigest = AbsentReplicaRootDigest | PresentReplicaRootDigest;

export interface ReplicaDivergenceEntry {
  readonly sequence: number;
  readonly observedAt: string;
  readonly state: ReplicaDivergenceState;
  readonly reason: ReplicaDivergenceReason;
  readonly legacyDigest: ReplicaRootDigest;
  readonly primaryDigest: ReplicaRootDigest;
  readonly targetPrimaryDigest: ReplicaRootDigest | null;
  readonly legacyRecoverySequence: number | null;
  readonly primaryRecoverySequence: number | null;
}

export interface ReplicaDivergenceEnvelope {
  readonly version: typeof REPLICA_DIVERGENCE_JOURNAL_VERSION;
  readonly ownerKey: string;
  readonly sourceOwnerKey: string;
  readonly legacyBaselineDigest: ReplicaRootDigest;
  readonly entries: readonly ReplicaDivergenceEntry[];
}

export type ReplicaDivergenceTransition = Omit<ReplicaDivergenceEntry, 'sequence' | 'observedAt'>;

export type ReplicaRootDigestFunction = (
  serializedReplica: string | null,
) => Promise<ReplicaRootDigest>;

export class ReplicaDivergenceJournalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReplicaDivergenceJournalError';
  }
}

const repositoryJournalQueues = new WeakMap<OwnerReplicaRepository, Map<string, Promise<void>>>();

function journalQueueFor(repository: OwnerReplicaRepository): Map<string, Promise<void>> {
  let queue = repositoryJournalQueues.get(repository);
  if (!queue) {
    queue = new Map();
    repositoryJournalQueues.set(repository, queue);
  }
  return queue;
}

export function replicaDivergenceJournalOwnerKey(sourceOwnerKey: string): string {
  if (!sourceOwnerKey) {
    throw new ReplicaDivergenceJournalError('Divergence journal source owner is required');
  }
  return DIVERGENCE_OWNER_PREFIX + encodeURIComponent(sourceOwnerKey);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function freezeDigest(digest: ReplicaRootDigest): ReplicaRootDigest {
  return Object.freeze({ ...digest });
}

function parseRootDigest(value: unknown): ReplicaRootDigest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplicaDivergenceJournalError('Replica root digest is invalid');
  }
  const digest = value as Record<string, unknown>;
  if (digest.kind === 'absent') {
    if (!exactKeys(digest, ['kind'])) {
      throw new ReplicaDivergenceJournalError('Absent replica digest has unexpected fields');
    }
    return Object.freeze({ kind: 'absent' });
  }
  if (
    !exactKeys(digest, ['algorithm', 'domain', 'hex', 'kind']) ||
    digest.kind !== 'sha256' ||
    digest.algorithm !== 'SHA-256' ||
    digest.domain !== REPLICA_ROOT_DIGEST_DOMAIN ||
    typeof digest.hex !== 'string' ||
    !SHA256_HEX.test(digest.hex)
  ) {
    throw new ReplicaDivergenceJournalError('Present replica digest is invalid');
  }
  return Object.freeze({
    kind: 'sha256',
    algorithm: 'SHA-256',
    domain: REPLICA_ROOT_DIGEST_DOMAIN,
    hex: digest.hex,
  });
}

export function sameReplicaRootDigest(left: ReplicaRootDigest, right: ReplicaRootDigest): boolean {
  if (left.kind === 'absent' || right.kind === 'absent') return left.kind === right.kind;
  return (
    left.algorithm === right.algorithm && left.domain === right.domain && left.hex === right.hex
  );
}

function validObservedAt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validReason(value: unknown): value is ReplicaDivergenceReason {
  return (
    value === 'promotion' ||
    value === 'commit' ||
    value === 'adopt-existing' ||
    value === 'resume' ||
    value === 'checkpoint' ||
    value === 'legacy-drift' ||
    value === 'primary-drift'
  );
}

function validRecoverySequence(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) > 0);
}

function validateEntryShape(
  value: unknown,
  index: number,
  baseline: ReplicaRootDigest,
): ReplicaDivergenceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplicaDivergenceJournalError('Divergence journal entry is invalid');
  }
  const entry = value as Record<string, unknown>;
  if (
    !exactKeys(entry, [
      'legacyDigest',
      'legacyRecoverySequence',
      'observedAt',
      'primaryDigest',
      'primaryRecoverySequence',
      'reason',
      'sequence',
      'state',
      'targetPrimaryDigest',
    ]) ||
    entry.sequence !== index + 1 ||
    !validObservedAt(entry.observedAt) ||
    !validReason(entry.reason) ||
    !['preparing', 'transactional', 'diverged'].includes(entry.state as string) ||
    !validRecoverySequence(entry.legacyRecoverySequence) ||
    !validRecoverySequence(entry.primaryRecoverySequence)
  ) {
    throw new ReplicaDivergenceJournalError('Divergence journal entry metadata is invalid');
  }

  const legacyDigest = parseRootDigest(entry.legacyDigest);
  const primaryDigest = parseRootDigest(entry.primaryDigest);
  const targetPrimaryDigest =
    entry.targetPrimaryDigest === null ? null : parseRootDigest(entry.targetPrimaryDigest);
  const state = entry.state as ReplicaDivergenceState;
  const reason = entry.reason;

  if (state === 'preparing') {
    if (
      targetPrimaryDigest?.kind !== 'sha256' ||
      !['promotion', 'commit', 'adopt-existing'].includes(reason) ||
      !sameReplicaRootDigest(legacyDigest, baseline) ||
      entry.legacyRecoverySequence !== null ||
      entry.primaryRecoverySequence !== null
    ) {
      throw new ReplicaDivergenceJournalError('Preparing divergence state is invalid');
    }
  } else if (state === 'transactional') {
    if (
      targetPrimaryDigest !== null ||
      !['promotion', 'commit', 'adopt-existing', 'resume', 'checkpoint'].includes(reason) ||
      !sameReplicaRootDigest(legacyDigest, baseline) ||
      entry.legacyRecoverySequence !== null ||
      entry.primaryRecoverySequence !== null
    ) {
      throw new ReplicaDivergenceJournalError('Transactional divergence state is invalid');
    }
  } else {
    if (
      targetPrimaryDigest !== null ||
      !['legacy-drift', 'primary-drift'].includes(reason) ||
      (reason === 'legacy-drift' && sameReplicaRootDigest(legacyDigest, baseline)) ||
      (legacyDigest.kind === 'absent'
        ? entry.legacyRecoverySequence !== null
        : entry.legacyRecoverySequence === null) ||
      (primaryDigest.kind === 'absent'
        ? entry.primaryRecoverySequence !== null
        : entry.primaryRecoverySequence === null)
    ) {
      throw new ReplicaDivergenceJournalError('Diverged replica state is invalid');
    }
  }

  return Object.freeze({
    sequence: entry.sequence as number,
    observedAt: entry.observedAt as string,
    state,
    reason,
    legacyDigest,
    primaryDigest,
    targetPrimaryDigest,
    legacyRecoverySequence: entry.legacyRecoverySequence as number | null,
    primaryRecoverySequence: entry.primaryRecoverySequence as number | null,
  });
}

function validateTransition(
  previous: ReplicaDivergenceEntry | undefined,
  current: ReplicaDivergenceEntry,
): void {
  if (!previous) {
    if (
      current.state === 'transactional' &&
      current.reason === 'checkpoint' &&
      current.primaryDigest.kind === 'sha256'
    ) {
      return;
    }
    if (current.state !== 'preparing') {
      throw new ReplicaDivergenceJournalError('Divergence journal must begin preparing');
    }
    const target = current.targetPrimaryDigest!;
    const validPromotion =
      current.reason === 'promotion' &&
      current.primaryDigest.kind === 'absent' &&
      current.legacyDigest.kind === 'sha256' &&
      sameReplicaRootDigest(current.legacyDigest, target);
    const validAdoption =
      current.reason === 'adopt-existing' &&
      current.primaryDigest.kind === 'sha256' &&
      sameReplicaRootDigest(current.primaryDigest, target);
    const validFreshCommit =
      current.reason === 'commit' &&
      current.primaryDigest.kind === 'absent' &&
      current.legacyDigest.kind === 'absent';
    if (!validPromotion && !validAdoption && !validFreshCommit) {
      throw new ReplicaDivergenceJournalError('Initial preparing transition is inconsistent');
    }
    return;
  }
  if (previous.state === 'preparing') {
    if (current.state !== 'transactional' && current.state !== 'diverged') {
      throw new ReplicaDivergenceJournalError('Preparing divergence transition is invalid');
    }
    if (current.state === 'transactional') {
      const reachedTarget = sameReplicaRootDigest(
        current.primaryDigest,
        previous.targetPrimaryDigest!,
      );
      const retainedPrevious = sameReplicaRootDigest(current.primaryDigest, previous.primaryDigest);
      if (
        (!reachedTarget && !retainedPrevious) ||
        (retainedPrevious && !reachedTarget && current.reason !== 'resume') ||
        (current.reason !== previous.reason && current.reason !== 'resume')
      ) {
        throw new ReplicaDivergenceJournalError(
          'Transactional transition does not resolve its preparation',
        );
      }
    } else if (current.reason === 'primary-drift') {
      const primaryChanged = !sameReplicaRootDigest(current.primaryDigest, previous.primaryDigest);
      const initialAdoptionMismatch =
        previous.reason === 'adopt-existing' &&
        sameReplicaRootDigest(current.primaryDigest, previous.primaryDigest) &&
        !sameReplicaRootDigest(current.legacyDigest, current.primaryDigest);
      if (!primaryChanged && !initialAdoptionMismatch) {
        throw new ReplicaDivergenceJournalError(
          'Primary divergence does not identify a changed or ambiguous root',
        );
      }
    }
    return;
  }
  if (previous.state === 'transactional') {
    if (current.state !== 'preparing' && current.state !== 'diverged') {
      throw new ReplicaDivergenceJournalError('Transactional divergence transition is invalid');
    }
    if (current.state === 'preparing') {
      if (
        current.reason !== 'commit' ||
        !sameReplicaRootDigest(current.primaryDigest, previous.primaryDigest) ||
        sameReplicaRootDigest(current.targetPrimaryDigest!, current.primaryDigest)
      ) {
        throw new ReplicaDivergenceJournalError(
          'Preparing commit does not continue the transactional root',
        );
      }
    } else if (
      current.reason === 'primary-drift' &&
      sameReplicaRootDigest(current.primaryDigest, previous.primaryDigest)
    ) {
      throw new ReplicaDivergenceJournalError(
        'Primary divergence does not change the transactional root',
      );
    }
    return;
  }
  if (current.state !== 'diverged') {
    throw new ReplicaDivergenceJournalError('Diverged replica state is absorbing');
  }
}

function freezeEnvelope(envelope: ReplicaDivergenceEnvelope): ReplicaDivergenceEnvelope {
  return Object.freeze({
    ...envelope,
    legacyBaselineDigest: freezeDigest(envelope.legacyBaselineDigest),
    entries: Object.freeze(envelope.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function parseReplicaDivergenceEnvelope(
  raw: string,
  sourceOwnerKey: string,
): ReplicaDivergenceEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ReplicaDivergenceJournalError('Divergence journal is not valid JSON', { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReplicaDivergenceJournalError('Divergence journal envelope is invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (
    !exactKeys(value, [
      'entries',
      'legacyBaselineDigest',
      'ownerKey',
      'sourceOwnerKey',
      'version',
    ]) ||
    value.version !== REPLICA_DIVERGENCE_JOURNAL_VERSION ||
    value.ownerKey !== replicaDivergenceJournalOwnerKey(sourceOwnerKey) ||
    value.sourceOwnerKey !== sourceOwnerKey ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    throw new ReplicaDivergenceJournalError('Divergence journal ownership or shape is invalid');
  }

  const baseline = parseRootDigest(value.legacyBaselineDigest);
  const entries: ReplicaDivergenceEntry[] = [];
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = validateEntryShape(value.entries[index], index, baseline);
    validateTransition(entries[index - 1], entry);
    entries.push(entry);
  }

  return freezeEnvelope({
    version: REPLICA_DIVERGENCE_JOURNAL_VERSION,
    ownerKey: replicaDivergenceJournalOwnerKey(sourceOwnerKey),
    sourceOwnerKey,
    legacyBaselineDigest: baseline,
    entries,
  });
}

export async function digestReplicaRoot(
  serializedReplica: string | null,
): Promise<ReplicaRootDigest> {
  if (serializedReplica === null) return Object.freeze({ kind: 'absent' });
  let hex: string;
  try {
    // Keep Expo's native module behind the async boundary. Default-off Node tests should not
    // have to parse React Native merely by importing this protocol module.
    const crypto = await import('expo-crypto');
    hex = await crypto.digestStringAsync(
      crypto.CryptoDigestAlgorithm.SHA256,
      REPLICA_ROOT_DIGEST_DOMAIN + '\u0000' + serializedReplica,
      { encoding: crypto.CryptoEncoding.HEX },
    );
  } catch (cause) {
    throw new ReplicaDivergenceJournalError('Replica root digest could not be computed', {
      cause,
    });
  }
  if (!SHA256_HEX.test(hex)) {
    throw new ReplicaDivergenceJournalError(
      'Replica root digest implementation returned invalid data',
    );
  }
  return Object.freeze({
    kind: 'sha256',
    algorithm: 'SHA-256',
    domain: REPLICA_ROOT_DIGEST_DOMAIN,
    hex,
  });
}

function transitionIdentity(
  transition: ReplicaDivergenceTransition,
): Omit<ReplicaDivergenceEntry, 'sequence' | 'observedAt'> {
  return {
    state: transition.state,
    reason: transition.reason,
    legacyDigest: transition.legacyDigest,
    primaryDigest: transition.primaryDigest,
    targetPrimaryDigest: transition.targetPrimaryDigest,
    legacyRecoverySequence: transition.legacyRecoverySequence,
    primaryRecoverySequence: transition.primaryRecoverySequence,
  };
}

function sameTransition(
  entry: ReplicaDivergenceEntry,
  transition: ReplicaDivergenceTransition,
): boolean {
  return (
    JSON.stringify(transitionIdentity(entry)) === JSON.stringify(transitionIdentity(transition))
  );
}

/**
 * Append strict digest-only transitions through the revision-fenced primary repository.
 *
 * Per-process sequencing and stale-CAS retry keep contiguous entries without overwriting a
 * transition another current client already verified.
 */
export class ReplicaDivergenceJournal {
  private readonly pending: Map<string, Promise<void>>;

  constructor(
    private readonly repository: OwnerReplicaRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly maxAttempts = 8,
    private readonly maxEntries = MAX_REPLICA_DIVERGENCE_ENTRIES,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new ReplicaDivergenceJournalError('Divergence journal entry limit is invalid');
    }
    this.pending = journalQueueFor(repository);
  }

  read(sourceOwnerKey: string): Promise<ReplicaDivergenceEnvelope | null> {
    const pending = this.pending.get(sourceOwnerKey) ?? Promise.resolve();
    return pending.catch(() => undefined).then(() => this.readDirect(sourceOwnerKey));
  }

  append(
    sourceOwnerKey: string,
    legacyBaselineDigest: ReplicaRootDigest,
    transition: ReplicaDivergenceTransition,
  ): Promise<ReplicaDivergenceEnvelope> {
    return this.enqueue(sourceOwnerKey, () =>
      this.appendWithRetry(sourceOwnerKey, legacyBaselineDigest, transition),
    );
  }

  requiresCompaction(entryCount: number): boolean {
    return entryCount > this.maxEntries;
  }

  /** Collapse only a verified transactional history; preparing/diverged evidence is never pruned. */
  compactTransactional(
    sourceOwnerKey: string,
    legacyBaselineDigest: ReplicaRootDigest,
    primaryDigest: ReplicaRootDigest,
  ): Promise<ReplicaDivergenceEnvelope> {
    return this.enqueue(sourceOwnerKey, () =>
      this.compactWithRetry(sourceOwnerKey, legacyBaselineDigest, primaryDigest),
    );
  }

  private enqueue<Result>(sourceOwnerKey: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.pending.get(sourceOwnerKey) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
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

  private async readDirect(sourceOwnerKey: string): Promise<ReplicaDivergenceEnvelope | null> {
    const raw = await this.repository.read(replicaDivergenceJournalOwnerKey(sourceOwnerKey));
    return raw === null ? null : parseReplicaDivergenceEnvelope(raw, sourceOwnerKey);
  }

  private async appendWithRetry(
    sourceOwnerKey: string,
    legacyBaselineDigest: ReplicaRootDigest,
    transition: ReplicaDivergenceTransition,
  ): Promise<ReplicaDivergenceEnvelope> {
    const checkedBaseline = parseRootDigest(legacyBaselineDigest);
    // Parse-normalize caller objects before identity comparison. Digest field insertion order is
    // not semantic and must not turn an idempotent retry into a second state transition.
    const checkedTransition = transitionIdentity(
      validateEntryShape(
        { ...transition, sequence: 1, observedAt: this.now() },
        0,
        checkedBaseline,
      ),
    );
    const ownerKey = replicaDivergenceJournalOwnerKey(sourceOwnerKey);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const current = await this.readDirect(sourceOwnerKey);
      if (current && !sameReplicaRootDigest(current.legacyBaselineDigest, checkedBaseline)) {
        throw new ReplicaDivergenceJournalError('Legacy baseline digest is immutable');
      }
      const last = current?.entries[current.entries.length - 1];
      if (last && sameTransition(last, checkedTransition)) return current;

      const nextEntry = Object.freeze({
        ...checkedTransition,
        sequence: (current?.entries.length ?? 0) + 1,
        observedAt: this.now(),
      });
      validateTransition(
        last,
        validateEntryShape(nextEntry, nextEntry.sequence - 1, checkedBaseline),
      );
      const next = freezeEnvelope({
        version: REPLICA_DIVERGENCE_JOURNAL_VERSION,
        ownerKey,
        sourceOwnerKey,
        legacyBaselineDigest: checkedBaseline,
        entries: [...(current?.entries ?? []), nextEntry],
      });
      const raw = JSON.stringify(next);
      const verified = parseReplicaDivergenceEnvelope(raw, sourceOwnerKey);
      try {
        await this.repository.commit(ownerKey, raw);
        return verified;
      } catch (cause) {
        if (cause instanceof ReplicaRepositoryStaleWriterError && attempt < this.maxAttempts) {
          continue;
        }
        throw new ReplicaDivergenceJournalError(
          'Divergence journal transition could not be verified',
          { cause },
        );
      }
    }
    throw new ReplicaDivergenceJournalError('Divergence journal retry budget was exhausted');
  }

  private async compactWithRetry(
    sourceOwnerKey: string,
    legacyBaselineDigest: ReplicaRootDigest,
    primaryDigest: ReplicaRootDigest,
  ): Promise<ReplicaDivergenceEnvelope> {
    const checkedBaseline = parseRootDigest(legacyBaselineDigest);
    const checkedPrimary = parseRootDigest(primaryDigest);
    if (checkedPrimary.kind !== 'sha256') {
      throw new ReplicaDivergenceJournalError(
        'Transactional checkpoint requires a present primary digest',
      );
    }
    const ownerKey = replicaDivergenceJournalOwnerKey(sourceOwnerKey);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const current = await this.readDirect(sourceOwnerKey);
      if (!current) {
        throw new ReplicaDivergenceJournalError('Transactional checkpoint has no journal');
      }
      if (!sameReplicaRootDigest(current.legacyBaselineDigest, checkedBaseline)) {
        throw new ReplicaDivergenceJournalError('Legacy baseline digest is immutable');
      }
      const last = current.entries[current.entries.length - 1]!;
      if (
        last.state !== 'transactional' ||
        !sameReplicaRootDigest(last.primaryDigest, checkedPrimary)
      ) {
        throw new ReplicaDivergenceJournalError(
          'Transactional checkpoint does not match verified authority',
        );
      }
      if (current.entries.length <= this.maxEntries) return current;

      const checkpoint = validateEntryShape(
        {
          sequence: 1,
          observedAt: this.now(),
          state: 'transactional',
          reason: 'checkpoint',
          legacyDigest: checkedBaseline,
          primaryDigest: checkedPrimary,
          targetPrimaryDigest: null,
          legacyRecoverySequence: null,
          primaryRecoverySequence: null,
        },
        0,
        checkedBaseline,
      );
      validateTransition(undefined, checkpoint);
      const next = freezeEnvelope({
        version: REPLICA_DIVERGENCE_JOURNAL_VERSION,
        ownerKey,
        sourceOwnerKey,
        legacyBaselineDigest: checkedBaseline,
        entries: [checkpoint],
      });
      const raw = JSON.stringify(next);
      const verified = parseReplicaDivergenceEnvelope(raw, sourceOwnerKey);
      try {
        await this.repository.commit(ownerKey, raw);
        return verified;
      } catch (cause) {
        if (cause instanceof ReplicaRepositoryStaleWriterError && attempt < this.maxAttempts) {
          continue;
        }
        throw new ReplicaDivergenceJournalError('Transactional checkpoint could not be verified', {
          cause,
        });
      }
    }
    throw new ReplicaDivergenceJournalError('Transactional checkpoint retry budget was exhausted');
  }
}
