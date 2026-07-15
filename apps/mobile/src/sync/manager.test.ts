import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, SyncMutation, SyncPushRequest, SyncPushResponse } from '@iris/shared';

const memory = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failSetKey: null as string | null,
}));
const apiMock = vi.hoisted(() => ({
  calls: [] as { token: string; method: 'register' | 'push' | 'changes' }[],
  pushPromise: null as Promise<SyncPushResponse> | null,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('../state/storage', () => ({
  storage: {
    get: async (key: string) => memory.values.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (memory.failSetKey === key) throw new Error('injected write failure');
      memory.values.set(key, value);
    },
    remove: async (key: string) => {
      memory.values.delete(key);
    },
  },
}));
vi.mock('../api', () => ({
  apiForLease: (lease: { token: string; workspaceId: string }) => ({
    registerDevice: async () => {
      apiMock.calls.push({ token: lease.token, method: 'register' });
      return { activeDevices: 1 };
    },
    syncPush: async (body: SyncPushRequest) => {
      apiMock.calls.push({ token: lease.token, method: 'push' });
      if (apiMock.pushPromise) return apiMock.pushPromise;
      return {
        applied: body.mutations.map((item) => ({
          opId: item.opId,
          note: {
            ...item.note,
            workspaceId: lease.workspaceId,
            version: item.baseVersion + 1,
            createdAt: '2026-07-15T10:00:00.000Z',
            updatedAt: '2026-07-15T12:00:00.000Z',
            deletedAt: item.type === 'delete' ? '2026-07-15T12:00:00.000Z' : null,
          },
        })),
        conflicts: [],
      };
    },
    syncChanges: async (cursor: string) => {
      apiMock.calls.push({ token: lease.token, method: 'changes' });
      return { changes: [], cursor, hasMore: false };
    },
  }),
}));

import {
  adoptSession,
  loadState,
  ownerKeyFor,
  saveState,
  stateStorageKeys,
  store$,
  type Session,
} from '../state/store';
import { keepLocalConflict, sync, useServerConflict } from './manager';

const workspaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const noteId = '33333333-3333-4333-8333-333333333333';

const sessionA: Session = {
  token: 'token-A',
  userId: userA,
  workspaceId: workspaceA,
  email: 'a@example.com',
  displayName: 'A',
};
const sessionB: Session = {
  token: 'token-B',
  userId: userB,
  workspaceId: workspaceB,
  email: 'b@example.com',
  displayName: 'B',
};

function note(workspaceId: string, bodyMd: string, version = 3): Note {
  return {
    id: noteId,
    workspaceId,
    title: bodyMd,
    bodyMd,
    folder: null,
    tags: [],
    version,
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
    deletedAt: null,
  };
}

function localMutation(bodyMd: string, opId = 'op-local'): SyncMutation {
  return {
    opId,
    type: 'upsert',
    note: { id: noteId, title: bodyMd, bodyMd, folder: null, tags: [] },
    baseVersion: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function installConflict(session: Session, opId = 'op-local'): Promise<void> {
  const server = note(session.workspaceId, 'server');
  const local = localMutation('local draft', opId);
  store$.notes.set({ [noteId]: server });
  store$.conflicts.set({
    [noteId]: {
      noteId,
      localMutation: local,
      serverNote: server,
      detectedAt: '2026-07-15T12:00:00.000Z',
    },
  });
  expect(await saveState()).toBe(true);
}

beforeEach(async () => {
  memory.values.clear();
  memory.failSetKey = null;
  apiMock.calls = [];
  apiMock.pushPromise = null;
  await loadState();
  await adoptSession(sessionA);
  await installConflict(sessionA);
});

describe('owner-fenced conflict decisions', () => {
  it('rejects a callback rendered for another owner', async () => {
    const ownerA = ownerKeyFor(sessionA);
    await adoptSession(sessionB);
    await installConflict(sessionB, 'op-B');

    expect(await keepLocalConflict(ownerA, noteId, 'op-local')).toBe(false);
    expect(store$.conflicts.get()[noteId]?.localMutation.opId).toBe('op-B');
    expect(store$.outbox.get()).toEqual([]);
  });

  it('rejects a stale callback for an older conflict operation', async () => {
    expect(await useServerConflict(ownerKeyFor(sessionA), noteId, 'older-op')).toBe(false);
    expect(store$.conflicts.get()[noteId]?.localMutation.opId).toBe('op-local');
  });

  it('requeues the reviewed local draft against the server head', async () => {
    expect(await keepLocalConflict(ownerKeyFor(sessionA), noteId, 'op-local')).toBe(true);
    expect(store$.conflicts.get()).toEqual({});
    expect(store$.notes.get()[noteId]?.bodyMd).toBe('local draft');
    expect(store$.outbox.get()).toHaveLength(1);
    expect(store$.outbox.get()[0]).toMatchObject({
      type: 'upsert',
      baseVersion: 3,
      note: { id: noteId, bodyMd: 'local draft' },
    });
    expect(store$.outbox.get()[0]?.opId).not.toBe('op-local');
  });

  it('retains the conflict when accepting the server cannot be persisted', async () => {
    memory.failSetKey = stateStorageKeys.replica(ownerKeyFor(sessionA));

    expect(await useServerConflict(ownerKeyFor(sessionA), noteId, 'op-local')).toBe(false);
    expect(store$.conflicts.get()[noteId]?.localMutation.opId).toBe('op-local');
    expect(store$.status.get()).toBe('error');
  });
});

describe('production manager composition', () => {
  it('discards a delayed A push after adopting B', async () => {
    const draft = note(workspaceA, 'A private draft', 1);
    const pending = localMutation(draft.bodyMd, 'op-A');
    store$.conflicts.set({});
    store$.notes.set({ [noteId]: draft });
    store$.outbox.set([pending]);
    expect(await saveState()).toBe(true);

    const push = deferred<SyncPushResponse>();
    apiMock.pushPromise = push.promise;
    const runningA = sync();
    await vi.waitFor(() =>
      expect(
        apiMock.calls.some((call) => call.token === sessionA.token && call.method === 'push'),
      ).toBe(true),
    );

    await adoptSession(sessionB);
    push.resolve({
      applied: [{ opId: pending.opId, note: note(workspaceA, 'server A', 2) }],
      conflicts: [],
    });
    await runningA;

    expect(store$.session.get()).toEqual(sessionB);
    expect(store$.notes.get()).toEqual({});
    expect(store$.outbox.get()).toEqual([]);
    expect(
      apiMock.calls.filter((call) => call.method === 'push').map((call) => call.token),
    ).toEqual([sessionA.token]);

    apiMock.pushPromise = null;
    await adoptSession({ ...sessionA, token: 'token-A-return' });
    expect(store$.notes.get()[noteId]?.bodyMd).toBe('A private draft');
    expect(store$.outbox.get()).toEqual([pending]);
  });
});
