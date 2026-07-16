import { describe, expect, it, vi } from 'vitest';

vi.mock('./storage', () => ({
  storage: {
    get: async () => null,
    set: async () => undefined,
    remove: async () => undefined,
  },
}));

import {
  TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
  ReplicaRepositoryStaleWriterError,
  TransactionalOwnerReplicaRepository,
  type CompareAndSwapResult,
  type TransactionalReplicaRecord,
  type TransactionalReplicaStore,
} from './transactional-replica-repository';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function serialized(ownerKey: string, value: string): string {
  return JSON.stringify({ version: 2, ownerKey, value });
}

class MemoryTransactionalStore implements TransactionalReplicaStore {
  readonly records = new Map<string, TransactionalReplicaRecord>();
  compareCalls = 0;
  readCalls = 0;
  beforeCompare?: (ownerKey: string, call: number) => Promise<void>;
  beforeRead?: (ownerKey: string, call: number) => Promise<void>;
  failBefore = false;
  failAfter = false;

  async read(ownerKey: string): Promise<TransactionalReplicaRecord | null> {
    this.readCalls += 1;
    await this.beforeRead?.(ownerKey, this.readCalls);
    return this.records.get(ownerKey) ?? null;
  }

  async compareAndSwap(
    ownerKey: string,
    expectedRevision: number,
    serializedReplica: string,
  ): Promise<CompareAndSwapResult> {
    this.compareCalls += 1;
    await this.beforeCompare?.(ownerKey, this.compareCalls);
    if (this.failBefore) {
      this.failBefore = false;
      throw new Error('failed before commit');
    }

    const current = this.records.get(ownerKey) ?? null;
    if ((current?.revision ?? 0) !== expectedRevision) {
      return { status: 'conflict', record: current };
    }
    const record: TransactionalReplicaRecord = {
      schemaVersion: TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
      ownerKey,
      revision: expectedRevision + 1,
      serializedReplica,
    };
    this.records.set(ownerKey, record);
    if (this.failAfter) {
      this.failAfter = false;
      throw new Error('failed after commit');
    }
    return { status: 'committed', record };
  }
}

describe('transactional owner replica repository', () => {
  it('preserves exact serialized bytes and advances one hidden revision per commit', async () => {
    const store = new MemoryTransactionalStore();
    const repository = new TransactionalOwnerReplicaRepository(store);
    const first = '{ "version": 2, "ownerKey": "owner-a", "value": "first" }';
    const second = serialized('owner-a', 'second');

    await repository.commit('owner-a', first);
    expect(store.records.get('owner-a')).toEqual({
      schemaVersion: 1,
      ownerKey: 'owner-a',
      revision: 1,
      serializedReplica: first,
    });
    await repository.commit('owner-a', second);
    expect(await repository.read('owner-a')).toBe(second);
    expect(store.records.get('owner-a')?.revision).toBe(2);
  });

  it('serializes one owner without blocking an independent owner', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const store = new MemoryTransactionalStore();
    store.beforeCompare = async (ownerKey, call) => {
      if (ownerKey === 'owner-a' && call === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    };
    const repository = new TransactionalOwnerReplicaRepository(store);

    const first = repository.commit('owner-a', serialized('owner-a', 'first'));
    await firstStarted.promise;
    const second = repository.commit('owner-a', serialized('owner-a', 'second'));
    await Promise.resolve();
    expect(store.compareCalls).toBe(1);

    const ownerB = serialized('owner-b', 'independent');
    await repository.commit('owner-b', ownerB);
    expect(await repository.read('owner-b')).toBe(ownerB);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(await repository.read('owner-a')).toBe(serialized('owner-a', 'second'));
  });

  it('queues a commit behind an in-flight authoritative read', async () => {
    const readStarted = deferred();
    const releaseRead = deferred();
    const store = new MemoryTransactionalStore();
    store.beforeRead = async (ownerKey, call) => {
      if (ownerKey === 'owner-a' && call === 1) {
        readStarted.resolve();
        await releaseRead.promise;
      }
    };
    const repository = new TransactionalOwnerReplicaRepository(store);

    const read = repository.read('owner-a');
    await readStarted.promise;
    const committed = serialized('owner-a', 'after-read');
    const commit = repository.commit('owner-a', committed);
    await Promise.resolve();
    expect(store.compareCalls).toBe(0);

    releaseRead.resolve();
    await expect(read).resolves.toBeNull();
    await expect(commit).resolves.toBeUndefined();
    expect(await repository.read('owner-a')).toBe(committed);
  });

  it('queues an authoritative read behind an in-flight commit', async () => {
    const commitStarted = deferred();
    const releaseCommit = deferred();
    const store = new MemoryTransactionalStore();
    store.beforeCompare = async (ownerKey, call) => {
      if (ownerKey === 'owner-a' && call === 1) {
        commitStarted.resolve();
        await releaseCommit.promise;
      }
    };
    const repository = new TransactionalOwnerReplicaRepository(store);
    const committed = serialized('owner-a', 'committed');

    const commit = repository.commit('owner-a', committed);
    await commitStarted.promise;
    let observed: string | null | undefined;
    const read = repository.read('owner-a').then((value) => {
      observed = value;
    });
    await Promise.resolve();
    expect(store.readCalls).toBe(0);
    expect(observed).toBeUndefined();

    releaseCommit.resolve();
    await Promise.all([commit, read]);
    expect(observed).toBe(committed);
    expect(store.readCalls).toBe(2);
  });

  it('rejects an embedded-owner mismatch before touching the transactional store', async () => {
    const store = new MemoryTransactionalStore();
    const repository = new TransactionalOwnerReplicaRepository(store);

    await expect(repository.commit('owner-b', serialized('owner-a', 'private'))).rejects.toThrow(
      'does not match its storage owner',
    );
    expect(store.compareCalls).toBe(0);
  });

  it('accepts a compare-and-swap that committed before reporting failure', async () => {
    const store = new MemoryTransactionalStore();
    store.failAfter = true;
    const repository = new TransactionalOwnerReplicaRepository(store);
    const committed = serialized('owner-a', 'committed');

    await expect(repository.commit('owner-a', committed)).resolves.toBeUndefined();
    expect(await repository.read('owner-a')).toBe(committed);
    expect(store.records.get('owner-a')?.revision).toBe(1);
  });

  it('recovers its queue after a non-committing storage failure', async () => {
    const store = new MemoryTransactionalStore();
    store.failBefore = true;
    const repository = new TransactionalOwnerReplicaRepository(store);

    await expect(repository.commit('owner-a', serialized('owner-a', 'lost'))).rejects.toThrow(
      'did not reach durable storage',
    );
    const recovered = serialized('owner-a', 'recovered');
    await expect(repository.commit('owner-a', recovered)).resolves.toBeUndefined();
    expect(await repository.read('owner-a')).toBe(recovered);
  });

  it('never overwrites an existing owner that this repository has not read', async () => {
    const store = new MemoryTransactionalStore();
    const existing = serialized('owner-a', 'existing');
    await store.compareAndSwap('owner-a', 0, existing);
    const repository = new TransactionalOwnerReplicaRepository(store);

    await expect(
      repository.commit('owner-a', serialized('owner-a', 'unseen-writer')),
    ).rejects.toBeInstanceOf(ReplicaRepositoryStaleWriterError);
    expect(store.records.get('owner-a')?.serializedReplica).toBe(existing);

    const callsAfterConflict = store.compareCalls;
    await expect(
      repository.commit('owner-a', serialized('owner-a', 'still-fenced')),
    ).rejects.toBeInstanceOf(ReplicaRepositoryStaleWriterError);
    expect(store.compareCalls).toBe(callsAfterConflict);
  });

  it('fences a stale instance until an explicit authoritative read', async () => {
    const store = new MemoryTransactionalStore();
    const winner = new TransactionalOwnerReplicaRepository(store);
    const stale = new TransactionalOwnerReplicaRepository(store);
    await Promise.all([winner.read('owner-a'), stale.read('owner-a')]);

    const winnerRaw = serialized('owner-a', 'winner');
    await winner.commit('owner-a', winnerRaw);
    await expect(stale.commit('owner-a', serialized('owner-a', 'stale'))).rejects.toBeInstanceOf(
      ReplicaRepositoryStaleWriterError,
    );

    const callsAfterConflict = store.compareCalls;
    await expect(
      stale.commit('owner-a', serialized('owner-a', 'still-stale')),
    ).rejects.toBeInstanceOf(ReplicaRepositoryStaleWriterError);
    expect(store.compareCalls).toBe(callsAfterConflict);

    expect(await stale.read('owner-a')).toBe(winnerRaw);
    const afterRehydrate = serialized('owner-a', 'after-rehydrate');
    await expect(stale.commit('owner-a', afterRehydrate)).resolves.toBeUndefined();
    expect(store.records.get('owner-a')?.serializedReplica).toBe(afterRehydrate);
  });

  it('accepts an idempotent conflict when another instance already wrote exact bytes', async () => {
    const store = new MemoryTransactionalStore();
    const first = new TransactionalOwnerReplicaRepository(store);
    const second = new TransactionalOwnerReplicaRepository(store);
    await Promise.all([first.read('owner-a'), second.read('owner-a')]);
    const identical = serialized('owner-a', 'identical');

    await first.commit('owner-a', identical);
    await expect(second.commit('owner-a', identical)).resolves.toBeUndefined();
    expect(await second.read('owner-a')).toBe(identical);
    expect(store.records.get('owner-a')?.revision).toBe(1);
  });
});
