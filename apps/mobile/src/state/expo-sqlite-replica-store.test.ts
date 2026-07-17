import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The store's dependency chain reaches replica-repository → storage → react-native.
// Mock storage (as the IndexedDB store test does) so the RN entrypoint never loads.
vi.mock('./storage', () => ({
  storage: {
    get: async () => null,
    set: async () => undefined,
    remove: async () => undefined,
  },
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

/**
 * The store depends only on the `ReplicaSqliteDatabase` seam. The real app satisfies it
 * with expo-sqlite; here we satisfy it with Node's built-in `node:sqlite` so the exact
 * compare-and-swap contract runs against real SQLite off-device. (Native force-quit
 * durability and true multi-connection concurrency remain device-acceptance gates.)
 */
class NodeSqliteReplicaDatabase implements ReplicaSqliteDatabase {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec('PRAGMA busy_timeout = 0');
  }

  async execAsync(source: string): Promise<void> {
    this.db.exec(source);
  }

  async getFirstAsync<T>(source: string, ...params: ReplicaSqliteParam[]): Promise<T | null> {
    const row = this.db.prepare(source).get(...params);
    return (row as T | undefined) ?? null;
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

const files: string[] = [];
const connections: DatabaseSync[] = [];

function tempFile(): string {
  const file = join(tmpdir(), `iris-sqlite-replica-${randomUUID()}.db`);
  files.push(file);
  return file;
}

function connect(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  connections.push(db);
  return db;
}

function memoryStore(): ExpoSqliteTransactionalReplicaStore {
  return new ExpoSqliteTransactionalReplicaStore(new NodeSqliteReplicaDatabase(connect()));
}

function serialized(ownerKey: string, value: string): string {
  return JSON.stringify({ version: 2, ownerKey, value });
}

afterEach(() => {
  for (const db of connections.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const file of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(file + suffix)) rmSync(file + suffix, { force: true });
    }
  }
});

describe('SQLite transactional replica store', () => {
  it('creates, reads, and revision-checks exact owner replica bytes', async () => {
    const store = memoryStore();
    const first = '{ "version": 2, "ownerKey": "owner-a", "value": "first" }';
    const second = serialized('owner-a', 'second');

    expect(await store.read('owner-a')).toBeNull();
    await expect(store.compareAndSwap('owner-a', 0, first)).resolves.toEqual({
      status: 'committed',
      record: { schemaVersion: 1, ownerKey: 'owner-a', revision: 1, serializedReplica: first },
    });
    await expect(store.compareAndSwap('owner-a', 1, second)).resolves.toMatchObject({
      status: 'committed',
      record: { revision: 2, serializedReplica: second },
    });
    expect(await store.read('owner-a')).toMatchObject({ revision: 2, serializedReplica: second });
  });

  it('returns the authoritative record on a revision mismatch without overwriting it', async () => {
    const store = memoryStore();
    const winner = serialized('owner-a', 'winner');
    await store.compareAndSwap('owner-a', 0, winner);

    await expect(
      store.compareAndSwap('owner-a', 0, serialized('owner-a', 'loser')),
    ).resolves.toEqual({
      status: 'conflict',
      record: { schemaVersion: 1, ownerKey: 'owner-a', revision: 1, serializedReplica: winner },
    });
    expect((await store.read('owner-a'))?.serializedReplica).toBe(winner);
  });

  it('keeps owners isolated', async () => {
    const store = memoryStore();
    await store.compareAndSwap('owner-a', 0, serialized('owner-a', 'a'));
    await store.compareAndSwap('owner-b', 0, serialized('owner-b', 'b'));
    expect((await store.read('owner-a'))?.serializedReplica).toBe(serialized('owner-a', 'a'));
    expect((await store.read('owner-b'))?.serializedReplica).toBe(serialized('owner-b', 'b'));
    // A swap on owner-b at its own revision does not disturb owner-a.
    await store.compareAndSwap('owner-b', 1, serialized('owner-b', 'b2'));
    expect((await store.read('owner-a'))?.revision).toBe(1);
  });

  it('fences a repository whose observed revision has been superseded', async () => {
    // Two repositories over one store both read revision 0; only the first commit wins,
    // the second is fenced and must fully rehydrate (same contract as the IndexedDB store).
    const store = memoryStore();
    const first = new TransactionalOwnerReplicaRepository(store);
    const second = new TransactionalOwnerReplicaRepository(store);
    await first.read('owner-a');
    await second.read('owner-a');

    await first.commit('owner-a', serialized('owner-a', 'first'));
    await expect(second.commit('owner-a', serialized('owner-a', 'second'))).rejects.toBeInstanceOf(
      ReplicaRepositoryStaleWriterError,
    );

    // The winner's bytes are intact; after an authoritative read the fence clears.
    expect(await second.read('owner-a')).toBe(serialized('owner-a', 'first'));
    await expect(second.commit('owner-a', serialized('owner-a', 'third'))).resolves.toBeUndefined();
    expect((await store.read('owner-a'))?.serializedReplica).toBe(serialized('owner-a', 'third'));
  });

  it('rejects a stored record whose serialized owner does not match its key', async () => {
    const db = connect();
    const store = new ExpoSqliteTransactionalReplicaStore(new NodeSqliteReplicaDatabase(db));
    await store.compareAndSwap('owner-a', 0, serialized('owner-a', 'valid'));

    // Corrupt the row so its embedded owner points elsewhere.
    db.prepare('UPDATE owner_replicas SET serialized_replica = ? WHERE owner_key = ?').run(
      serialized('owner-b', 'misrouted'),
      'owner-a',
    );

    await expect(store.read('owner-a')).rejects.toThrow('SQLite owner replica record is invalid');
  });

  it('exclusively locks writes across connections (the primitive CAS relies on)', async () => {
    // Proves the write-lock mutual exclusion that serializes concurrent swaps: while one
    // connection holds an EXCLUSIVE transaction, another cannot begin a write.
    const file = tempFile();
    const a = connect(file);
    const b = connect(file);
    a.exec('PRAGMA busy_timeout = 0');
    b.exec('PRAGMA busy_timeout = 0');
    a.exec('CREATE TABLE owner_replicas (owner_key TEXT PRIMARY KEY)');

    a.exec('BEGIN EXCLUSIVE');
    expect(() => b.exec('BEGIN IMMEDIATE')).toThrow();
    a.exec('ROLLBACK');
    // Once released, the other connection can write.
    expect(() => b.exec('BEGIN IMMEDIATE')).not.toThrow();
    b.exec('ROLLBACK');
  });
});
