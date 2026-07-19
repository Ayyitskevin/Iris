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
 * runtime adopts the primary. ADR-023 now detects and preserves that split, including a frozen
 * old-runtime browser gate. Use this flag only in controlled tests until enforceable old-client
 * compatibility, recovery resolution, and native acceptance gates are complete.
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
import {
  AlwaysWritableOwnerAuthorityDriver,
  WebOwnerAuthorityDriver,
  type BroadcastChannelPort,
  type OwnerAuthorityDriver,
  type OwnerLockPort,
} from './owner-replica-authority';
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
  /** Current-runtime web exclusivity, required before IndexedDB may become authoritative. */
  webLocks: OwnerLockPort | undefined;
  /** Owner-scoped invalidation channel factory; messages never carry replica bytes. */
  createBroadcastChannel: ((name: string) => BroadcastChannelPort) | undefined;
}

export type OwnerReplicaRuntimeMode = 'legacy' | 'transactional-web' | 'transactional-native';

export interface OwnerReplicaRuntime {
  readonly repository: OwnerReplicaRepository;
  /** Raw backend for control/recovery records; never route it back through promotion. */
  readonly recoveryRepository: OwnerReplicaRepository;
  readonly authority: OwnerAuthorityDriver;
  readonly mode: OwnerReplicaRuntimeMode;
  /** Read the durable/legacy winner without promoting or committing from a follower. */
  readFollower(ownerKey: string): Promise<string | null>;
  /** Resolve or verify the mixed-version journal before publishing write authority. */
  prepareOwner(ownerKey: string): Promise<void>;
  /** Recheck the exact legacy baseline immediately before an authenticated request. */
  verifyBeforeNetwork(ownerKey: string): Promise<void>;
}

/** Read the environment without importing `react-native` — capability detection only. */
export function detectReplicaEnvironment(): ReplicaEnvironment {
  const flag = process.env.EXPO_PUBLIC_DURABLE_STORAGE;
  const globals = globalThis as {
    indexedDB?: IDBFactory;
    navigator?: { product?: string; locks?: OwnerLockPort };
    BroadcastChannel?: new (name: string) => BroadcastChannelPort;
  };
  const Channel = globals.BroadcastChannel;
  return {
    durableEnabled: flag === '1' || flag === 'true',
    indexedDB: globals.indexedDB,
    isReactNative: globals.navigator?.product === 'ReactNative',
    webLocks: globals.navigator?.locks,
    createBroadcastChannel: Channel ? (name) => new Channel(name) : undefined,
  };
}

/** Pick the platform's transactional store, or null when none is available (Node/SSR). */
function legacyRuntime(legacy: OwnerReplicaRepository): OwnerReplicaRuntime {
  return {
    repository: legacy,
    recoveryRepository: legacy,
    authority: new AlwaysWritableOwnerAuthorityDriver(),
    mode: 'legacy',
    readFollower: (ownerKey) => legacy.read(ownerKey),
    prepareOwner: async () => undefined,
    verifyBeforeNetwork: async () => undefined,
  };
}

/**
 * Assemble the production repository. With the flag off — or on a platform without a
 * transactional store — this returns the legacy key/value repository unchanged.
 */
export function selectOwnerReplicaRepository(
  env: ReplicaEnvironment,
  legacy: OwnerReplicaRepository = new SerializedKvReplicaRepository(storage),
): OwnerReplicaRepository {
  return selectOwnerReplicaRuntime(env, legacy).repository;
}

/**
 * Assemble storage and current-runtime authority as one decision. Web never selects IndexedDB
 * unless every coordination primitive exists; a missing primitive returns the exact legacy
 * repository without opening a database, lock, or channel.
 */
export function selectOwnerReplicaRuntime(
  env: ReplicaEnvironment,
  legacy: OwnerReplicaRepository = new SerializedKvReplicaRepository(storage),
): OwnerReplicaRuntime {
  if (!env.durableEnabled) return legacyRuntime(legacy);

  if (env.indexedDB) {
    if (!env.webLocks || !env.createBroadcastChannel) return legacyRuntime(legacy);
    const primary = new TransactionalOwnerReplicaRepository(
      new IndexedDbTransactionalReplicaStore(env.indexedDB),
    );
    const repository = new PromotingOwnerReplicaRepository(primary, legacy);
    return {
      repository,
      recoveryRepository: primary,
      authority: new WebOwnerAuthorityDriver({
        locks: env.webLocks,
        createChannel: env.createBroadcastChannel,
      }),
      mode: 'transactional-web',
      readFollower: async (ownerKey) => (await primary.read(ownerKey)) ?? legacy.read(ownerKey),
      prepareOwner: (ownerKey) => repository.prepareOwner(ownerKey),
      verifyBeforeNetwork: (ownerKey) => repository.verifyBeforeNetwork(ownerKey),
    };
  }

  if (env.isReactNative) {
    const primary = new TransactionalOwnerReplicaRepository(
      new LazyTransactionalReplicaStore(() => openExpoSqliteReplicaStore()),
    );
    const repository = new PromotingOwnerReplicaRepository(primary, legacy);
    return {
      repository,
      recoveryRepository: primary,
      authority: new AlwaysWritableOwnerAuthorityDriver(),
      mode: 'transactional-native',
      readFollower: (ownerKey) => primary.read(ownerKey),
      prepareOwner: (ownerKey) => repository.prepareOwner(ownerKey),
      verifyBeforeNetwork: (ownerKey) => repository.verifyBeforeNetwork(ownerKey),
    };
  }

  return legacyRuntime(legacy);
}

/** The singleton the owner store commits and reads through. */
export const ownerReplicaRuntime: OwnerReplicaRuntime = selectOwnerReplicaRuntime(
  detectReplicaEnvironment(),
);
export const ownerReplicaRepository: OwnerReplicaRepository = ownerReplicaRuntime.repository;
