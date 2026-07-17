/**
 * Lazy storage-backend migration for the Sync v2 cutover (plan A3, step 1).
 *
 * The transactional stores (IndexedDB — ADR-017; SQLite — ADR-020) are durable and
 * revision-fenced, but the shipped production replica still lives in the size-limited
 * SecureStore/localStorage key/value backend. To flip authority without losing a user's
 * existing replica, the first read of an owner whose transactional record is absent
 * adopts the legacy key/value bytes into the transactional store.
 *
 * This is a self-contained, unwired primitive — like the stores themselves. Selecting it
 * as the production `ownerReplicaRepository` also requires making `store.ts` fence-aware
 * (a `ReplicaRepositoryStaleWriterError` must trigger a re-read + rehydrate, not a plain
 * rollback) — that is step 2. The platform store selection + the actual flip are step 3.
 */
import { type OwnerReplicaRepository } from './replica-repository';
import { ReplicaRepositoryStaleWriterError } from './transactional-replica-repository';

export class PromotingOwnerReplicaRepository implements OwnerReplicaRepository {
  // One promotion attempt per owner per process; after it, `primary` is authoritative.
  private readonly attempted = new Set<string>();

  constructor(
    /** The durable, revision-fenced destination (transactional store). */
    private readonly primary: OwnerReplicaRepository,
    /** The existing key/value replica being migrated away from. */
    private readonly legacy: OwnerReplicaRepository,
  ) {}

  async read(ownerKey: string): Promise<string | null> {
    const current = await this.primary.read(ownerKey);
    if (current !== null || this.attempted.has(ownerKey)) return current;

    // The transactional store has nothing for this owner yet. Adopt legacy bytes once.
    this.attempted.add(ownerKey);
    const legacyBytes = await this.legacy.read(ownerKey);
    if (legacyBytes === null) return null;

    try {
      await this.primary.commit(ownerKey, legacyBytes);
      return legacyBytes;
    } catch (error) {
      if (error instanceof ReplicaRepositoryStaleWriterError) {
        // Another process/tab promoted the same owner first. Its commit is authoritative;
        // re-read clears this repository's fence and returns the winning bytes.
        return this.primary.read(ownerKey);
      }
      throw error;
    }
  }

  commit(ownerKey: string, serializedReplica: string): Promise<void> {
    // All writes go straight to the durable store; the legacy copy is never written again
    // (it remains only as an inert backup until an explicit later cleanup).
    return this.primary.commit(ownerKey, serializedReplica);
  }
}
