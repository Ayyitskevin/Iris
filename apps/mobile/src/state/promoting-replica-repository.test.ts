import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Break the react-native import chain (store → storage → RN), like the store tests do.
vi.mock('./storage', () => ({
  storage: { get: async () => null, set: async () => undefined, remove: async () => undefined },
}));

import {
  ExpoSqliteTransactionalReplicaStore,
  type ReplicaSqliteDatabase,
  type ReplicaSqliteParam,
  type ReplicaSqliteRunner,
} from './expo-sqlite-replica-store';
import {
  ReplicaRepositoryStaleWriterError,
  TransactionalOwnerReplicaRepository,
} from './transactional-replica-repository';
import type { OwnerReplicaRepository } from './replica-repository';
import { PromotingOwnerReplicaRepository } from './promoting-replica-repository';

// --- node:sqlite adapter for the ReplicaSqliteDatabase seam ------------------
class NodeSqliteReplicaDatabase implements ReplicaSqliteDatabase {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec('PRAGMA busy_timeout = 0');
  }
  async execAsync(source: string): Promise<void> {
    this.db.exec(source);
  }
  async getFirstAsync<T>(source: string, ...params: ReplicaSqliteParam[]): Promise<T | null> {
    return (this.db.prepare(source).get(...params) as T | undefined) ?? null;
  }
  async runAsync(source: string, ...params: ReplicaSqliteParam[]): Promise<unknown> {
    return this.db.prepare(source).run(...params);
  }
  async withExclusiveTransactionAsync(
    task: (txn: ReplicaSqliteRunner) => Promise<void>,
  ): Promise<void> {
    this.db.exec('BEGIN EXCLUSIVE');
    try {
      await task(this);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw error;
    }
  }
}

const connections: DatabaseSync[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

/** A real transactional repository backed by an in-memory SQLite database. */
function sqliteRepo(): TransactionalOwnerReplicaRepository {
  const db = new DatabaseSync(':memory:');
  connections.push(db);
  return new TransactionalOwnerReplicaRepository(
    new ExpoSqliteTransactionalReplicaStore(new NodeSqliteReplicaDatabase(db)),
  );
}

class MemoryRepo implements OwnerReplicaRepository {
  private readonly data = new Map<string, string>();
  constructor(seed?: Record<string, string>) {
    if (seed) for (const [k, v] of Object.entries(seed)) this.data.set(k, v);
  }
  set(ownerKey: string, bytes: string): void {
    this.data.set(ownerKey, bytes);
  }
  async read(ownerKey: string): Promise<string | null> {
    return this.data.get(ownerKey) ?? null;
  }
  async commit(ownerKey: string, serializedReplica: string): Promise<void> {
    this.data.set(ownerKey, serializedReplica);
  }
}

function serialized(ownerKey: string, value: string): string {
  return JSON.stringify({ version: 2, ownerKey, value });
}

describe('PromotingOwnerReplicaRepository', () => {
  it('adopts legacy bytes into the durable store on first read', async () => {
    const primary = sqliteRepo();
    const legacy = new MemoryRepo({ 'owner-a': serialized('owner-a', 'legacy') });
    const promoting = new PromotingOwnerReplicaRepository(primary, legacy);

    expect(await promoting.read('owner-a')).toBe(serialized('owner-a', 'legacy'));
    // The transactional store now durably owns it.
    expect(await primary.read('owner-a')).toBe(serialized('owner-a', 'legacy'));
    // Subsequent commits go to the durable store (at the promoted revision).
    await promoting.commit('owner-a', serialized('owner-a', 'updated'));
    expect(await primary.read('owner-a')).toBe(serialized('owner-a', 'updated'));
  });

  it('returns null and then persists a fresh replica when nothing exists anywhere', async () => {
    const primary = sqliteRepo();
    const promoting = new PromotingOwnerReplicaRepository(primary, new MemoryRepo());

    expect(await promoting.read('owner-x')).toBeNull();
    await promoting.commit('owner-x', serialized('owner-x', 'fresh'));
    expect(await primary.read('owner-x')).toBe(serialized('owner-x', 'fresh'));
  });

  it('ignores the legacy copy entirely when the durable store already has the owner', async () => {
    const primary = sqliteRepo();
    await primary.commit('owner-a', serialized('owner-a', 'primary-wins'));
    // A legacy repo that throws if it is ever read proves it is not consulted.
    const legacy: OwnerReplicaRepository = {
      read: async () => {
        throw new Error('legacy must not be read when the durable store has the owner');
      },
      commit: async () => undefined,
    };
    const promoting = new PromotingOwnerReplicaRepository(primary, legacy);

    expect(await promoting.read('owner-a')).toBe(serialized('owner-a', 'primary-wins'));
  });

  it('shows why client-only promotion cannot cut over: later legacy writes are ignored', async () => {
    const primary = sqliteRepo();
    const legacy = new MemoryRepo({ 'owner-a': serialized('owner-a', 'legacy') });
    const promoting = new PromotingOwnerReplicaRepository(primary, legacy);

    expect(await promoting.read('owner-a')).toBe(serialized('owner-a', 'legacy'));
    legacy.set('owner-a', serialized('owner-a', 'changed-legacy'));
    expect(await promoting.read('owner-a')).toBe(serialized('owner-a', 'legacy'));
  });

  it('adopts the winner when a concurrent writer promoted the owner first', async () => {
    let reads = 0;
    const primary: OwnerReplicaRepository = {
      read: async () => (reads++ === 0 ? null : serialized('owner-a', 'winner')),
      commit: async () => {
        throw new ReplicaRepositoryStaleWriterError('owner-a');
      },
    };
    const legacy = new MemoryRepo({ 'owner-a': serialized('owner-a', 'legacy') });
    const promoting = new PromotingOwnerReplicaRepository(primary, legacy);

    expect(await promoting.read('owner-a')).toBe(serialized('owner-a', 'winner'));
  });

  it('propagates a non-fence commit failure during promotion', async () => {
    const primary: OwnerReplicaRepository = {
      read: async () => null,
      commit: async () => {
        throw new Error('disk is on fire');
      },
    };
    const legacy = new MemoryRepo({ 'owner-a': serialized('owner-a', 'legacy') });
    const promoting = new PromotingOwnerReplicaRepository(primary, legacy);

    await expect(promoting.read('owner-a')).rejects.toThrow('disk is on fire');
  });

  it('delegates commit straight to the durable store without touching legacy', async () => {
    const primary = sqliteRepo();
    const legacy = new MemoryRepo();
    const promoting = new PromotingOwnerReplicaRepository(primary, legacy);

    await promoting.commit('owner-b', serialized('owner-b', 'direct'));
    expect(await primary.read('owner-b')).toBe(serialized('owner-b', 'direct'));
    expect(await legacy.read('owner-b')).toBeNull();
  });

  it('retries promotion after a transient commit failure instead of stranding the legacy replica', async () => {
    const durable = sqliteRepo();
    let failNextCommit = true;
    // A durable store whose first commit fails transiently, then recovers.
    const flaky: OwnerReplicaRepository = {
      read: (ownerKey) => durable.read(ownerKey),
      commit: async (ownerKey, bytes) => {
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error('transient store failure');
        }
        return durable.commit(ownerKey, bytes);
      },
    };
    const legacy = new MemoryRepo({ 'owner-a': serialized('owner-a', 'legacy') });
    const promoting = new PromotingOwnerReplicaRepository(flaky, legacy);

    // First read: the promotion commit fails and the error propagates.
    await expect(promoting.read('owner-a')).rejects.toThrow('transient store failure');
    // The owner was NOT marked attempted, so the next read retries and promotes for real.
    expect(await promoting.read('owner-a')).toBe(serialized('owner-a', 'legacy'));
    expect(await durable.read('owner-a')).toBe(serialized('owner-a', 'legacy'));
  });

  it('retries promotion after a transient legacy-read failure', async () => {
    const primary = sqliteRepo();
    let failNextRead = true;
    const legacy: OwnerReplicaRepository = {
      read: async () => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('legacy read failure');
        }
        return serialized('owner-a', 'legacy');
      },
      commit: async () => undefined,
    };
    const promoting = new PromotingOwnerReplicaRepository(primary, legacy);

    await expect(promoting.read('owner-a')).rejects.toThrow('legacy read failure');
    // Not stranded: the second read reaches the legacy bytes and promotes them.
    expect(await promoting.read('owner-a')).toBe(serialized('owner-a', 'legacy'));
    expect(await primary.read('owner-a')).toBe(serialized('owner-a', 'legacy'));
  });
});
