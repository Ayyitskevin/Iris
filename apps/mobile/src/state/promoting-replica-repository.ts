/**
 * Lazy storage-backend migration for the Sync v2 cutover (plan A3, step 1).
 *
 * The transactional stores (IndexedDB — ADR-017; SQLite — ADR-020) are durable and
 * revision-fenced, but the shipped production replica still lives in the size-limited
 * SecureStore/localStorage key/value backend. To flip authority without losing a user's
 * existing replica, the first read of an owner whose transactional record is absent
 * adopts the legacy key/value bytes into the transactional store.
 *
 * This is a staging primitive, not a complete cutover protocol. Fence-aware store semantics
 * are required but insufficient: this class does not mark the legacy record as promoted, so an
 * old tab/binary can keep writing bytes the new runtime no longer reads. Production selection
 * therefore also requires divergence detection, one web leader, recovery UX, and an enforceable
 * old-client compatibility contract tracked in A3 step 3b.
 */
import { type OwnerReplicaRepository } from './replica-repository';
import { ReplicaRepositoryStaleWriterError } from './transactional-replica-repository';

export class PromotingOwnerReplicaRepository implements OwnerReplicaRepository {
  // One attempt per owner per process; only this repository instance then treats primary as authority.
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

    // The transactional store has nothing for this owner yet: try to adopt the legacy bytes.
    // The attempt is recorded ONLY once its outcome is definitive — promoted, nothing to
    // promote, or a concurrent writer won. A transient failure (the store was briefly
    // unavailable, the read threw) must NOT be recorded: otherwise the next read would return
    // the empty primary, and a subsequent fresh edit would permanently supersede the
    // un-promoted legacy replica — silently losing the user's existing notes.
    const legacyBytes = await this.legacy.read(ownerKey);
    if (legacyBytes === null) {
      this.attempted.add(ownerKey);
      return null;
    }

    try {
      await this.primary.commit(ownerKey, legacyBytes);
      this.attempted.add(ownerKey);
      return legacyBytes;
    } catch (error) {
      if (error instanceof ReplicaRepositoryStaleWriterError) {
        // Another process/tab promoted the same owner first. Its commit is authoritative;
        // re-read clears this repository's fence and returns the winning bytes.
        this.attempted.add(ownerKey);
        return this.primary.read(ownerKey);
      }
      // Transient failure: leave the owner un-attempted so the next read retries the promotion.
      throw error;
    }
  }

  commit(ownerKey: string, serializedReplica: string): Promise<void> {
    // This instance writes only the primary. The legacy copy is NOT globally inert: a journal
    // can detect but cannot stop older runtimes mutating it until they are explicitly fenced.
    return this.primary.commit(ownerKey, serializedReplica);
  }
}
