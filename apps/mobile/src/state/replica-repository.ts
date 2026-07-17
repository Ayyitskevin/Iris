/**
 * Durable owner-replica boundary.
 *
 * The current adapter stores one serialized replica in the existing key/value backend.
 * It is intentionally not described as the release SQLite/IndexedDB implementation:
 * callers depend only on owner-keyed reads and serialized, verified replacement commits.
 */
import { type KVStore } from './storage';

export function replicaStorageKey(ownerKey: string): string {
  return 'iris.replica.v2.' + ownerKey;
}

export class ReplicaRepositoryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReplicaRepositoryError';
  }
}

export function assertSerializedReplicaOwner(ownerKey: string, serializedReplica: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedReplica) as unknown;
  } catch (cause) {
    throw new ReplicaRepositoryError('Owner replica commit is not valid JSON', { cause });
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { ownerKey?: unknown }).ownerKey !== ownerKey
  ) {
    throw new ReplicaRepositoryError('Owner replica commit does not match its storage owner');
  }
}

export interface OwnerReplicaRepository {
  /** Wait for current-process writes, then return the last durable owner snapshot. */
  read(ownerKey: string): Promise<string | null>;
  /** Serialize replacement commits per owner and verify the exact durable bytes. */
  commit(ownerKey: string, serializedReplica: string): Promise<void>;
}

/** Interim single-record adapter behind the repository contract. */
export class SerializedKvReplicaRepository implements OwnerReplicaRepository {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly backend: KVStore,
    private readonly keyFor: (ownerKey: string) => string = replicaStorageKey,
  ) {}

  async read(ownerKey: string): Promise<string | null> {
    // A failed replacement leaves the earlier durable record authoritative. Reads may
    // continue after that failure, while the caller that requested the commit still sees it.
    await (this.pending.get(ownerKey) ?? Promise.resolve()).catch(() => undefined);
    return this.backend.get(this.keyFor(ownerKey));
  }

  commit(ownerKey: string, serializedReplica: string): Promise<void> {
    try {
      // Validate only immutable routing metadata. The payload is written byte-for-byte so
      // a newer mutation shape remains lossless until its owning client can interpret it.
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
    const key = this.keyFor(ownerKey);
    let operationError: unknown;
    try {
      await this.backend.set(key, serializedReplica);
    } catch (error) {
      operationError = error;
    }

    let observed: string | null;
    try {
      observed = await this.backend.get(key);
    } catch (cause) {
      throw new ReplicaRepositoryError('Owner replica replacement could not be verified', {
        cause: operationError ?? cause,
      });
    }
    if (observed !== serializedReplica) {
      throw new ReplicaRepositoryError('Owner replica replacement did not reach durable storage', {
        cause: operationError,
      });
    }
  }
}

// The production singleton is assembled by `./select-owner-replica-repository`, which picks
// the platform's fenced transactional store behind an opt-in flag and otherwise falls back to
// `SerializedKvReplicaRepository`. This module stays a set of building blocks with no runtime
// storage decision of its own.
