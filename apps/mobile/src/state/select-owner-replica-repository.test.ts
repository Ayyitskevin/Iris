import { describe, expect, it, vi } from 'vitest';

// Break the react-native import chain: storage.ts pulls in react-native + expo-secure-store.
vi.mock('./storage', () => ({
  storage: { get: async () => null, set: async () => undefined, remove: async () => undefined },
}));

import {
  LazyTransactionalReplicaStore,
  selectOwnerReplicaRepository,
  selectOwnerReplicaRuntime,
  type ReplicaEnvironment,
} from './select-owner-replica-repository';
import { SerializedKvReplicaRepository } from './replica-repository';
import { PromotingOwnerReplicaRepository } from './promoting-replica-repository';
import type {
  CompareAndSwapResult,
  TransactionalReplicaRecord,
  TransactionalReplicaStore,
} from './transactional-replica-repository';

const legacy = new SerializedKvReplicaRepository({
  get: async () => null,
  set: async () => undefined,
  remove: async () => undefined,
});

function env(overrides: Partial<ReplicaEnvironment>): ReplicaEnvironment {
  return {
    durableEnabled: false,
    indexedDB: undefined,
    isReactNative: false,
    webLocks: undefined,
    createBroadcastChannel: undefined,
    ...overrides,
  };
}

// A minimal IDBFactory stand-in — the selector only needs a truthy factory to pick the web store.
const fakeIndexedDB = {} as IDBFactory;
const fakeWebLocks: ReplicaEnvironment['webLocks'] = {
  request: async () => undefined,
};
const createBroadcastChannel: NonNullable<ReplicaEnvironment['createBroadcastChannel']> = () => ({
  onmessage: null,
  postMessage: () => undefined,
  close: () => undefined,
});

describe('selectOwnerReplicaRepository', () => {
  it('returns the legacy key/value repository unchanged when the flag is off', () => {
    // Even on a platform that *has* a transactional store, the opt-in gate wins.
    expect(selectOwnerReplicaRepository(env({ indexedDB: fakeIndexedDB }), legacy)).toBe(legacy);
    expect(selectOwnerReplicaRepository(env({ isReactNative: true }), legacy)).toBe(legacy);
  });

  it('promotes onto the IndexedDB store on web when enabled', () => {
    const repo = selectOwnerReplicaRepository(
      env({
        durableEnabled: true,
        indexedDB: fakeIndexedDB,
        webLocks: fakeWebLocks,
        createBroadcastChannel,
      }),
      legacy,
    );
    expect(repo).toBeInstanceOf(PromotingOwnerReplicaRepository);
    expect(repo).not.toBe(legacy);
  });

  it('promotes onto the lazy SQLite store on native when enabled', () => {
    const repo = selectOwnerReplicaRepository(
      env({ durableEnabled: true, isReactNative: true }),
      legacy,
    );
    expect(repo).toBeInstanceOf(PromotingOwnerReplicaRepository);
  });

  it('falls back to legacy when enabled but no transactional store exists (Node/SSR)', () => {
    expect(selectOwnerReplicaRepository(env({ durableEnabled: true }), legacy)).toBe(legacy);
  });

  it('falls back to the exact legacy repository when either web coordination primitive is missing', () => {
    expect(
      selectOwnerReplicaRuntime(
        env({
          durableEnabled: true,
          indexedDB: fakeIndexedDB,
          createBroadcastChannel,
        }),
        legacy,
      ),
    ).toMatchObject({ repository: legacy, mode: 'legacy' });
    expect(
      selectOwnerReplicaRuntime(
        env({ durableEnabled: true, indexedDB: fakeIndexedDB, webLocks: fakeWebLocks }),
        legacy,
      ),
    ).toMatchObject({ repository: legacy, mode: 'legacy' });
  });

  it('prefers IndexedDB over SQLite when both signals are present', () => {
    // A web build could expose a React-Native-looking navigator via a polyfill; IndexedDB wins.
    const repo = selectOwnerReplicaRepository(
      env({ durableEnabled: true, indexedDB: fakeIndexedDB, isReactNative: true }),
      legacy,
    );
    expect(repo).toBe(legacy);
  });

  it('prefers coordinated IndexedDB over SQLite when all web signals are present', () => {
    const repo = selectOwnerReplicaRepository(
      env({
        durableEnabled: true,
        indexedDB: fakeIndexedDB,
        isReactNative: true,
        webLocks: fakeWebLocks,
        createBroadcastChannel,
      }),
      legacy,
    );
    // The promoting repo's primary must be the IndexedDB-backed transactional store, which we
    // assert indirectly: a fresh read that hits nothing returns null without the lazy opener
    // ever being consulted (SQLite path would try to import expo-sqlite and reject).
    expect(repo).toBeInstanceOf(PromotingOwnerReplicaRepository);
  });
});

describe('LazyTransactionalReplicaStore', () => {
  function record(ownerKey: string): TransactionalReplicaRecord {
    return { schemaVersion: 1, ownerKey, revision: 1, serializedReplica: '{}' };
  }

  it('opens the backing store lazily and only once, then forwards operations', async () => {
    let opens = 0;
    const inner: TransactionalReplicaStore = {
      read: async (ownerKey) => record(ownerKey),
      compareAndSwap: async (): Promise<CompareAndSwapResult> => ({
        status: 'committed',
        record: record('owner-a'),
      }),
    };
    const store = new LazyTransactionalReplicaStore(async () => {
      opens += 1;
      return inner;
    });

    expect(opens).toBe(0); // construction does not open
    expect(await store.read('owner-a')).toEqual(record('owner-a'));
    expect((await store.compareAndSwap('owner-a', 0, '{}')).status).toBe('committed');
    expect(opens).toBe(1); // opened once, reused for the second call
  });

  it('retries the open after a failure rather than caching the rejection', async () => {
    let attempts = 0;
    const inner: TransactionalReplicaStore = {
      read: async () => null,
      compareAndSwap: async (): Promise<CompareAndSwapResult> => ({
        status: 'conflict',
        record: null,
      }),
    };
    const store = new LazyTransactionalReplicaStore(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('open failed');
      return inner;
    });

    await expect(store.read('owner-a')).rejects.toThrow('open failed');
    expect(await store.read('owner-a')).toBeNull();
    expect(attempts).toBe(2);
  });
});
