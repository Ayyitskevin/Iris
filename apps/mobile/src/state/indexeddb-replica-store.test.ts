import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./storage', () => ({
  storage: {
    get: async () => null,
    set: async () => undefined,
    remove: async () => undefined,
  },
}));

import { IndexedDbTransactionalReplicaStore } from './indexeddb-replica-store';
import {
  ReplicaRepositoryStaleWriterError,
  TransactionalOwnerReplicaRepository,
} from './transactional-replica-repository';

let databaseSequence = 0;
const openStores: IndexedDbTransactionalReplicaStore[] = [];

function createStore(): { name: string; store: IndexedDbTransactionalReplicaStore } {
  databaseSequence += 1;
  const name = `iris-indexeddb-test-${Date.now()}-${databaseSequence}`;
  const store = new IndexedDbTransactionalReplicaStore(indexedDB, name);
  openStores.push(store);
  return { name, store };
}

function serialized(ownerKey: string, value: string): string {
  return JSON.stringify({ version: 2, ownerKey, value });
}

async function seedRawRecord(
  databaseName: string,
  record: {
    schemaVersion: number;
    ownerKey: string;
    revision: number;
    serializedReplica: string;
  },
): Promise<void> {
  const request = indexedDB.open(databaseName, 1);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction('owner_replicas', 'readwrite');
  transaction.objectStore('owner_replicas').put(record);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

describe('IndexedDB transactional replica store', () => {
  it('creates, reads, and revision-checks exact owner replica bytes', async () => {
    const { store } = createStore();
    const first = '{ "version": 2, "ownerKey": "owner-a", "value": "first" }';
    const second = serialized('owner-a', 'second');

    expect(await store.read('owner-a')).toBeNull();
    await expect(store.compareAndSwap('owner-a', 0, first)).resolves.toEqual({
      status: 'committed',
      record: {
        schemaVersion: 1,
        ownerKey: 'owner-a',
        revision: 1,
        serializedReplica: first,
      },
    });
    await expect(store.compareAndSwap('owner-a', 1, second)).resolves.toMatchObject({
      status: 'committed',
      record: { revision: 2, serializedReplica: second },
    });
    expect(await store.read('owner-a')).toMatchObject({
      revision: 2,
      serializedReplica: second,
    });
  });

  it('returns the authoritative record on a revision mismatch without overwriting it', async () => {
    const { store } = createStore();
    const winner = serialized('owner-a', 'winner');
    await store.compareAndSwap('owner-a', 0, winner);

    await expect(
      store.compareAndSwap('owner-a', 0, serialized('owner-a', 'loser')),
    ).resolves.toEqual({
      status: 'conflict',
      record: {
        schemaVersion: 1,
        ownerKey: 'owner-a',
        revision: 1,
        serializedReplica: winner,
      },
    });
    expect((await store.read('owner-a'))?.serializedReplica).toBe(winner);
  });

  it('serializes simultaneous compare-and-swap transactions from separate connections', async () => {
    const { name, store: first } = createStore();
    const second = new IndexedDbTransactionalReplicaStore(indexedDB, name);
    openStores.push(second);
    await Promise.all([first.read('owner-a'), second.read('owner-a')]);
    const firstRaw = serialized('owner-a', 'first');
    const secondRaw = serialized('owner-a', 'second');

    const results = await Promise.all([
      first.compareAndSwap('owner-a', 0, firstRaw),
      second.compareAndSwap('owner-a', 0, secondRaw),
    ]);
    expect(results.filter((result) => result.status === 'committed')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'conflict')).toHaveLength(1);

    const committed = results.find((result) => result.status === 'committed');
    const conflict = results.find((result) => result.status === 'conflict');
    expect(committed?.record.revision).toBe(1);
    expect(conflict?.record).toEqual(committed?.record);
    expect((await second.read('owner-a'))?.serializedReplica).toBe(
      committed?.record.serializedReplica,
    );
  });

  it('atomically fences one of two racing repositories on separate connections', async () => {
    const { name, store: firstStore } = createStore();
    const secondStore = new IndexedDbTransactionalReplicaStore(indexedDB, name);
    openStores.push(secondStore);
    const first = new TransactionalOwnerReplicaRepository(firstStore);
    const second = new TransactionalOwnerReplicaRepository(secondStore);
    await Promise.all([first.read('owner-a'), second.read('owner-a')]);

    const candidates = [serialized('owner-a', 'first'), serialized('owner-a', 'second')];
    const results = await Promise.allSettled([
      first.commit('owner-a', candidates[0]!),
      second.commit('owner-a', candidates[1]!),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ReplicaRepositoryStaleWriterError);

    const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
    expect(await firstStore.read('owner-a')).toMatchObject({
      revision: 1,
      serializedReplica: candidates[winnerIndex],
    });
  });

  it('rejects a stored record whose serialized owner does not match its key', async () => {
    const { name, store } = createStore();
    await store.compareAndSwap('owner-a', 0, serialized('owner-a', 'valid'));
    await seedRawRecord(name, {
      schemaVersion: 1,
      ownerKey: 'owner-a',
      revision: 2,
      serializedReplica: serialized('owner-b', 'misrouted'),
    });

    await expect(store.read('owner-a')).rejects.toThrow(
      'IndexedDB owner replica record is invalid',
    );
  });
});
