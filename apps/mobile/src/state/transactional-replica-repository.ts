/**
 * Revisioned owner-replica boundary for transactional platform stores.
 *
 * This is deliberately not selected by the runtime yet. A platform migration also
 * needs owner-specific legacy promotion and browser session/leader fencing. Keeping
 * the storage primitive separate lets those cutover rules be tested before any
 * deployed localStorage replica changes authority.
 */
import {
  assertSerializedReplicaOwner,
  type OwnerReplicaRepository,
  ReplicaRepositoryError,
} from './replica-repository';

export const TRANSACTIONAL_REPLICA_SCHEMA_VERSION = 1 as const;

export interface TransactionalReplicaRecord {
  schemaVersion: typeof TRANSACTIONAL_REPLICA_SCHEMA_VERSION;
  ownerKey: string;
  revision: number;
  serializedReplica: string;
}

export type CompareAndSwapResult =
  | { status: 'committed'; record: TransactionalReplicaRecord }
  | { status: 'conflict'; record: TransactionalReplicaRecord | null };

export interface TransactionalReplicaStore {
  read(ownerKey: string): Promise<TransactionalReplicaRecord | null>;
  compareAndSwap(
    ownerKey: string,
    expectedRevision: number,
    serializedReplica: string,
  ): Promise<CompareAndSwapResult>;
}

export class ReplicaRepositoryStaleWriterError extends ReplicaRepositoryError {
  constructor(ownerKey: string, options?: { cause?: unknown }) {
    super(
      `Owner replica writer for ${ownerKey} is stale; read and fully rehydrate the authoritative replica before retrying`,
      options,
    );
    this.name = 'ReplicaRepositoryStaleWriterError';
  }
}

export function assertTransactionalReplicaRecord(
  ownerKey: string,
  record: TransactionalReplicaRecord,
): void {
  if (
    !record ||
    typeof record !== 'object' ||
    record.schemaVersion !== TRANSACTIONAL_REPLICA_SCHEMA_VERSION ||
    record.ownerKey !== ownerKey ||
    !Number.isSafeInteger(record.revision) ||
    record.revision <= 0 ||
    typeof record.serializedReplica !== 'string'
  ) {
    throw new ReplicaRepositoryError('Transactional owner replica record is invalid');
  }
  assertSerializedReplicaOwner(ownerKey, record.serializedReplica);
}

/**
 * Owner-scoped repository with optimistic revision checks.
 *
 * A conflicting writer is fenced rather than silently refreshed: the optimistic
 * in-memory projection may contain edits based on the losing revision. An explicit
 * read returns the authoritative bytes and clears the fence; callers must fully
 * rehydrate those bytes before committing again.
 */
export class TransactionalOwnerReplicaRepository implements OwnerReplicaRepository {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly observedRevisions = new Map<string, number>();
  private readonly fencedOwners = new Set<string>();

  constructor(private readonly store: TransactionalReplicaStore) {}

  read(ownerKey: string): Promise<string | null> {
    // Reads join the same owner queue as commits. Otherwise a commit started while an
    // initial read is in flight could use revision 0, and the late read could then
    // overwrite the revision observed by that commit.
    const previous = this.pending.get(ownerKey) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        const record = await this.store.read(ownerKey);
        if (record) assertTransactionalReplicaRecord(ownerKey, record);
        this.observedRevisions.set(ownerKey, record?.revision ?? 0);
        this.fencedOwners.delete(ownerKey);
        return record?.serializedReplica ?? null;
      });
    const completed = result.then(() => undefined);
    this.pending.set(ownerKey, completed);
    void completed.then(
      () => this.release(ownerKey, completed),
      () => this.release(ownerKey, completed),
    );
    return result;
  }

  commit(ownerKey: string, serializedReplica: string): Promise<void> {
    try {
      assertSerializedReplicaOwner(ownerKey, serializedReplica);
    } catch (error) {
      return Promise.reject(error);
    }

    const previous = this.pending.get(ownerKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.replaceAndVerify(ownerKey, serializedReplica));

    this.pending.set(ownerKey, next);
    void next.then(
      () => this.release(ownerKey, next),
      () => this.release(ownerKey, next),
    );
    return next;
  }

  private release(ownerKey: string, completed: Promise<void>): void {
    if (this.pending.get(ownerKey) === completed) this.pending.delete(ownerKey);
  }

  private async replaceAndVerify(ownerKey: string, serializedReplica: string): Promise<void> {
    if (this.fencedOwners.has(ownerKey)) {
      throw new ReplicaRepositoryStaleWriterError(ownerKey);
    }

    // A repository instance that has not read this owner may create revision 1, but
    // it may never overwrite an existing record it has not observed.
    const expectedRevision = this.observedRevisions.get(ownerKey) ?? 0;
    let outcome: CompareAndSwapResult | undefined;
    let operationError: unknown;
    try {
      outcome = await this.store.compareAndSwap(ownerKey, expectedRevision, serializedReplica);
      if (outcome.record) assertTransactionalReplicaRecord(ownerKey, outcome.record);
    } catch (error) {
      operationError = error;
    }

    let observed: TransactionalReplicaRecord | null;
    try {
      observed = await this.store.read(ownerKey);
      if (observed) assertTransactionalReplicaRecord(ownerKey, observed);
    } catch (cause) {
      throw new ReplicaRepositoryError('Transactional owner replica commit could not be verified', {
        cause: operationError ?? cause,
      });
    }

    // This also accepts a compare-and-swap that durably committed before reporting
    // an error, or an idempotent conflict whose durable bytes are already exact.
    if (observed?.serializedReplica === serializedReplica) {
      this.observedRevisions.set(ownerKey, observed.revision);
      return;
    }

    const observedRevision = observed?.revision ?? 0;
    if (outcome?.status === 'conflict' || observedRevision !== expectedRevision) {
      this.fencedOwners.add(ownerKey);
      throw new ReplicaRepositoryStaleWriterError(ownerKey, {
        cause: operationError,
      });
    }

    throw new ReplicaRepositoryError(
      'Transactional owner replica commit did not reach durable storage',
      { cause: operationError },
    );
  }
}
