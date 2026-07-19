/**
 * Production owner-replica repository selection (plan A3, step 3a).
 *
 * This is the seam that flips durable storage authority from the legacy key/value backend
 * (SecureStore/localStorage) to the revision-fenced transactional stores — IndexedDB on web
 * (ADR-017), SQLite on native (ADR-020) — through the lazy `PromotingOwnerReplicaRepository`
 * so an existing replica is migrated on first read.
 *
 * The selector is gated behind `EXPO_PUBLIC_DURABLE_STORAGE`, which defaults OFF. Correct
 * stale-CAS recovery in `store.ts` prevents false commit acknowledgements, but it does not make
 * legacy promotion cutover-safe: old tabs/binaries can still write the legacy key after a new
 * runtime adopts the primary. Use this flag only in controlled tests until the mixed-version
 * divergence journal, web leadership, enforceable old-client compatibility, recovery UX, and
 * browser/device acceptance gates are complete.
 *
 * Deliberately a leaf module (nothing here imports it back) and free of any static
 * `react-native`/`expo-sqlite` import, so it loads cleanly under Node/vitest.
 */
import { SerializedKvReplicaRepository, type OwnerReplicaRepository } from './replica-repository';
import {
  TransactionalOwnerReplicaRepository,
  type CompareAndSwapResult,
  type TransactionalReplicaRecord,
  type TransactionalReplicaStore,
} from './transactional-replica-repository';
import { IndexedDbTransactionalReplicaStore } from './indexeddb-replica-store';
import { openExpoSqliteReplicaStore } from './open-expo-sqlite-store';
import { PromotingOwnerReplicaRepository } from './promoting-replica-repository';
import { storage } from './storage';

/**
 * A `TransactionalReplicaStore` whose real backend is opened lazily and once. Native SQLite
 * can only be opened asynchronously (a dynamic `expo-sqlite` import), but the repository
 * contract is synchronous to construct, so the open is deferred to the first operation.
 */
export class LazyTransactionalReplicaStore implements TransactionalReplicaStore {
  private opening: Promise<TransactionalReplicaStore> | null = null;

  constructor(private readonly open: () => Promise<TransactionalReplicaStore>) {}

  private store(): Promise<TransactionalReplicaStore> {
    if (!this.opening) {
      this.opening = this.open().catch((error: unknown) => {
        // Let the next call retry rather than caching a rejected open forever.
        this.opening = null;
        throw error;
      });
    }
    return this.opening;
  }

  async read(ownerKey: string): Promise<TransactionalReplicaRecord | null> {
    return (await this.store()).read(ownerKey);
  }

  async compareAndSwap(
    ownerKey: string,
    expectedRevision: number,
    serializedReplica: string,
  ): Promise<CompareAndSwapResult> {
    return (await this.store()).compareAndSwap(ownerKey, expectedRevision, serializedReplica);
  }
}

export interface ReplicaEnvironment {
  /** The opt-in flag: is the fenced transactional store selected at all? */
  durableEnabled: boolean;
  /** The web IndexedDB factory, when present. */
  indexedDB: IDBFactory | undefined;
  /** Whether this is a React Native (device) runtime. */
  isReactNative: boolean;
}

/** Read the environment without importing `react-native` — capability detection only. */
export function detectReplicaEnvironment(): ReplicaEnvironment {
  const flag = process.env.EXPO_PUBLIC_DURABLE_STORAGE;
  const globals = globalThis as {
    indexedDB?: IDBFactory;
    navigator?: { product?: string };
  };
  return {
    durableEnabled: flag === '1' || flag === 'true',
    indexedDB: globals.indexedDB,
    isReactNative: globals.navigator?.product === 'ReactNative',
  };
}

/** Pick the platform's transactional store, or null when none is available (Node/SSR). */
function selectTransactionalStore(env: ReplicaEnvironment): TransactionalReplicaStore | null {
  if (env.indexedDB) return new IndexedDbTransactionalReplicaStore(env.indexedDB);
  if (env.isReactNative)
    return new LazyTransactionalReplicaStore(() => openExpoSqliteReplicaStore());
  return null;
}

/**
 * Assemble the production repository. With the flag off — or on a platform without a
 * transactional store — this returns the legacy key/value repository unchanged.
 */
export function selectOwnerReplicaRepository(
  env: ReplicaEnvironment,
  legacy: OwnerReplicaRepository = new SerializedKvReplicaRepository(storage),
): OwnerReplicaRepository {
  if (!env.durableEnabled) return legacy;
  const store = selectTransactionalStore(env);
  if (!store) return legacy;
  // Promote the existing key/value replica into the fenced store on first read.
  return new PromotingOwnerReplicaRepository(
    new TransactionalOwnerReplicaRepository(store),
    legacy,
  );
}

/** The singleton the owner store commits and reads through. */
export const ownerReplicaRepository: OwnerReplicaRepository = selectOwnerReplicaRepository(
  detectReplicaEnvironment(),
);
