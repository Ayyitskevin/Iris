import { describe, expect, it, vi } from 'vitest';

vi.mock('./storage', () => ({
  storage: {
    get: async () => null,
    set: async () => undefined,
    remove: async () => undefined,
  },
}));

import { replicaStorageKey, SerializedKvReplicaRepository } from './replica-repository';
import type { KVStore } from './storage';

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

function memoryStore(overrides: Partial<KVStore> = {}): KVStore & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    get: overrides.get ?? (async (key) => values.get(key) ?? null),
    set:
      overrides.set ??
      (async (key, value) => {
        values.set(key, value);
      }),
    remove:
      overrides.remove ??
      (async (key) => {
        values.delete(key);
      }),
  };
}

describe('serialized owner replica repository', () => {
  it('preserves the deployed replica-v2 key namespace', () => {
    expect(replicaStorageKey('workspace.user')).toBe('iris.replica.v2.workspace.user');
  });

  it('serializes same-owner replacements so a slow older write cannot win', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let calls = 0;
    const backend = memoryStore({
      set: async (key, value) => {
        calls += 1;
        if (calls === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        backend.values.set(key, value);
      },
    });
    const repository = new SerializedKvReplicaRepository(backend, (owner) => owner);

    const firstRaw = serialized('owner-a', 'first');
    const secondRaw = serialized('owner-a', 'second');
    const first = repository.commit('owner-a', firstRaw);
    await firstStarted.promise;
    const second = repository.commit('owner-a', secondRaw);
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(await repository.read('owner-a')).toBe(secondRaw);
  });

  it('does not block an independent owner behind a slow write', async () => {
    const ownerAStarted = deferred();
    const releaseOwnerA = deferred();
    const backend = memoryStore({
      set: async (key, value) => {
        if (key === 'owner-a') {
          ownerAStarted.resolve();
          await releaseOwnerA.promise;
        }
        backend.values.set(key, value);
      },
    });
    const repository = new SerializedKvReplicaRepository(backend, (owner) => owner);

    const ownerA = repository.commit('owner-a', serialized('owner-a', 'a'));
    await ownerAStarted.promise;
    const ownerBRaw = serialized('owner-b', 'b');
    await repository.commit('owner-b', ownerBRaw);
    expect(await repository.read('owner-b')).toBe(ownerBRaw);

    releaseOwnerA.resolve();
    await ownerA;
  });

  it('accepts a replacement that committed before the backend threw', async () => {
    const backend = memoryStore({
      set: async (key, value) => {
        backend.values.set(key, value);
        throw new Error('reported failure after commit');
      },
    });
    const repository = new SerializedKvReplicaRepository(backend, (owner) => owner);

    const committed = serialized('owner-a', 'committed');
    await expect(repository.commit('owner-a', committed)).resolves.toBeUndefined();
    expect(await repository.read('owner-a')).toBe(committed);
  });

  it('surfaces an unverified replacement without poisoning the owner queue', async () => {
    let fail = true;
    const backend = memoryStore({
      set: async (key, value) => {
        if (fail) {
          fail = false;
          throw new Error('did not commit');
        }
        backend.values.set(key, value);
      },
    });
    backend.values.set('owner-a', serialized('owner-a', 'old'));
    const repository = new SerializedKvReplicaRepository(backend, (owner) => owner);

    await expect(repository.commit('owner-a', serialized('owner-a', 'lost'))).rejects.toThrow(
      'did not reach durable',
    );
    const recovered = serialized('owner-a', 'recovered');
    await expect(repository.commit('owner-a', recovered)).resolves.toBeUndefined();
    expect(await repository.read('owner-a')).toBe(recovered);
  });

  it('waits for an in-flight owner replacement before reading', async () => {
    const started = deferred();
    const release = deferred();
    const backend = memoryStore({
      set: async (key, value) => {
        started.resolve();
        await release.promise;
        backend.values.set(key, value);
      },
    });
    const repository = new SerializedKvReplicaRepository(backend, (owner) => owner);

    const next = serialized('owner-a', 'next');
    const commit = repository.commit('owner-a', next);
    await started.promise;
    let observed: string | null | undefined;
    const read = repository.read('owner-a').then((value) => {
      observed = value;
    });
    await Promise.resolve();
    expect(observed).toBeUndefined();

    release.resolve();
    await Promise.all([commit, read]);
    expect(observed).toBe(next);
  });

  it('rejects bytes whose embedded owner does not match the storage owner', async () => {
    const backend = memoryStore();
    const repository = new SerializedKvReplicaRepository(backend, (owner) => owner);

    await expect(repository.commit('owner-b', serialized('owner-a', 'private'))).rejects.toThrow(
      'does not match its storage owner',
    );
    expect(backend.values.has('owner-b')).toBe(false);
  });
});
