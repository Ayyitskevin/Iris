import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, SyncMutation, SyncPushRequest, SyncPushResponse } from '@iris/shared';

const memory = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failSetKey: null as string | null,
  failSetOnceKey: null as string | null,
}));
const apiMock = vi.hoisted(() => ({
  calls: [] as {
    token: string;
    method: 'register' | 'push' | 'changes';
    body?: SyncPushRequest;
  }[],
  pushPromise: null as Promise<SyncPushResponse> | null,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('../state/storage', () => ({
  storage: {
    get: async (key: string) => memory.values.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (memory.failSetOnceKey === key) {
        memory.failSetOnceKey = null;
        throw new Error('injected one-time write failure');
      }
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
      apiMock.calls.push({ token: lease.token, method: 'push', body });
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
  openSessionLease,
  ownerKeyFor,
  saveState,
  stateStorageKeys,
  store$,
  updateReplicaForLease,
  type Session,
} from '../state/store';
import { mergeAuthoritativeNoteIfSafe } from '../history-safety';
import {
  createNoteLocal,
  deleteNoteLocal,
  keepLocalConflict,
  recoverSyncIssue,
  sync,
  updateNoteLocal,
  useServerConflict,
} from './manager';

const workspaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const noteId = '33333333-3333-4333-8333-333333333333';
const secondNoteId = '44444444-4444-4444-8444-444444444444';

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

function appliedResponse(workspaceId: string, mutations: SyncMutation[]): SyncPushResponse {
  return {
    applied: mutations.map((item) => ({
      opId: item.opId,
      note: {
        ...item.note,
        workspaceId,
        version: item.baseVersion + 1,
        createdAt: '2026-07-15T10:00:00.000Z',
        updatedAt: '2026-07-15T12:00:00.000Z',
        deletedAt: item.type === 'delete' ? '2026-07-15T12:00:00.000Z' : null,
      },
    })),
    conflicts: [],
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
  memory.failSetOnceKey = null;
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

  it('normalizes retained non-delete intent from the reviewed server lifecycle', async () => {
    const tombstone = {
      ...note(workspaceA, 'deleted server', 4),
      deletedAt: '2026-07-15T12:00:00.000Z',
    };
    const retained = localMutation('retained draft', 'op-retained');
    store$.notes.set({ [noteId]: tombstone });
    store$.outbox.set([]);
    store$.pendingPush.set(null);
    store$.conflicts.set({
      [noteId]: {
        noteId,
        localMutation: retained,
        serverNote: tombstone,
        detectedAt: '2026-07-15T12:01:00.000Z',
      },
    });
    store$.syncIssue.set({
      code: 'test_hold',
      message: 'Keep the reviewed mutation unstaged during this assertion',
      affectedOpIds: [],
      recoveryKind: 'retry',
    });

    expect(await keepLocalConflict(ownerKeyFor(sessionA), noteId, retained.opId)).toBe(true);
    expect(store$.outbox.get()[0]).toMatchObject({
      type: 'resurrect',
      baseVersion: 4,
      note: { id: noteId, bodyMd: 'retained draft' },
    });
    expect(store$.notes.get()[noteId]).toMatchObject({ bodyMd: 'retained draft', deletedAt: null });

    const liveServer = note(workspaceA, 'already revived elsewhere', 5);
    const staleResurrection: SyncMutation = {
      ...localMutation('newest retained draft', 'op-resurrect'),
      type: 'resurrect',
    };
    store$.notes.set({ [noteId]: liveServer });
    store$.outbox.set([]);
    store$.pendingPush.set(null);
    store$.conflicts.set({
      [noteId]: {
        noteId,
        localMutation: staleResurrection,
        serverNote: liveServer,
        detectedAt: '2026-07-15T12:02:00.000Z',
      },
    });

    expect(await keepLocalConflict(ownerKeyFor(sessionA), noteId, staleResurrection.opId)).toBe(
      true,
    );
    expect(store$.outbox.get()[0]).toMatchObject({
      type: 'upsert',
      baseVersion: 5,
      note: { id: noteId, bodyMd: 'newest retained draft' },
    });
  });

  it('keeps resurrection intent while collapsing edits before request staging', async () => {
    const tombstone = {
      ...note(workspaceA, 'deleted server', 4),
      deletedAt: '2026-07-15T12:00:00.000Z',
    };
    const retained = localMutation('retained body', 'op-retained');
    store$.notes.set({ [noteId]: tombstone });
    store$.outbox.set([]);
    store$.pendingPush.set(null);
    store$.conflicts.set({
      [noteId]: {
        noteId,
        localMutation: retained,
        serverNote: tombstone,
        detectedAt: '2026-07-15T12:01:00.000Z',
      },
    });
    store$.syncIssue.set({
      code: 'test_hold',
      message: 'Keep the resurrection unstaged while the next edit collapses it',
      affectedOpIds: [],
      recoveryKind: 'retry',
    });

    expect(await keepLocalConflict(ownerKeyFor(sessionA), noteId, retained.opId)).toBe(true);
    const reviewedOpId = store$.outbox.get()[0]!.opId;
    expect(updateNoteLocal(noteId, { title: 'Latest title' })).toBe(true);

    expect(store$.pendingPush.get()).toBeNull();
    expect(store$.outbox.get()).toHaveLength(1);
    expect(store$.outbox.get()[0]).toMatchObject({
      type: 'resurrect',
      baseVersion: 4,
      note: { id: noteId, title: 'Latest title', bodyMd: 'retained body' },
    });
    expect(store$.outbox.get()[0]!.opId).not.toBe(reviewedOpId);
    expect(await saveState()).toBe(true);
  });

  it('makes an edit after a staged resurrection a newer upsert', async () => {
    const resurrection: SyncMutation = {
      ...localMutation('reviewed body', 'op-resurrect'),
      type: 'resurrect',
      baseVersion: 4,
    };
    store$.notes.set({
      [noteId]: {
        ...note(workspaceA, 'reviewed body', 4),
        title: 'Reviewed title',
        deletedAt: null,
      },
    });
    store$.outbox.set([resurrection]);
    store$.pendingPush.set([resurrection]);
    store$.conflicts.set({});
    store$.syncIssue.set({
      code: 'test_hold',
      message: 'Keep the staged request fixed while the next edit is queued',
      affectedOpIds: [resurrection.opId],
      recoveryKind: 'retry',
    });

    expect(updateNoteLocal(noteId, { bodyMd: 'newest body' })).toBe(true);

    expect(store$.pendingPush.get()).toEqual([resurrection]);
    expect(store$.outbox.get()).toHaveLength(1);
    expect(store$.outbox.get()[0]).toMatchObject({
      type: 'upsert',
      baseVersion: 4,
      note: { id: noteId, title: 'Reviewed title', bodyMd: 'newest body' },
    });
    expect(store$.outbox.get()[0]!.opId).not.toBe(resurrection.opId);
    expect(await saveState()).toBe(true);
  });

  it('keeps the exact authoritative tombstone without queueing a mutation', async () => {
    const tombstone = {
      ...note(workspaceA, 'authoritative deleted body', 4),
      title: 'Authoritative deleted title',
      tags: ['server'],
      deletedAt: '2026-07-15T12:00:00.000Z',
    };
    const retained = localMutation('retained local draft', 'op-retained');
    store$.notes.set({ [noteId]: tombstone });
    store$.outbox.set([]);
    store$.pendingPush.set(null);
    store$.conflicts.set({
      [noteId]: {
        noteId,
        localMutation: retained,
        serverNote: tombstone,
        detectedAt: '2026-07-15T12:01:00.000Z',
      },
    });

    expect(await useServerConflict(ownerKeyFor(sessionA), noteId, retained.opId)).toBe(true);

    expect(store$.conflicts.get()).toEqual({});
    expect(store$.notes.get()[noteId]).toEqual(tombstone);
    expect(store$.outbox.get()).toEqual([]);
    expect(store$.pendingPush.get()).toBeNull();
  });

  it('retains the conflict when accepting the server cannot be persisted', async () => {
    memory.failSetKey = stateStorageKeys.replica(ownerKeyFor(sessionA));

    expect(await useServerConflict(ownerKeyFor(sessionA), noteId, 'op-local')).toBe(false);
    expect(store$.conflicts.get()[noteId]?.localMutation.opId).toBe('op-local');
    expect(store$.status.get()).toBe('error');
  });
});

describe('local tombstone guards', () => {
  it('does not edit, retag, or re-delete a tombstoned note', () => {
    const tombstone = {
      ...note(workspaceA, 'deleted body'),
      deletedAt: '2026-07-15T12:00:00.000Z',
    };
    store$.conflicts.set({});
    store$.notes.set({ [noteId]: tombstone });
    store$.outbox.set([]);

    expect(updateNoteLocal(noteId, { title: 'accidental resurrection' })).toBe(false);
    expect(updateNoteLocal(noteId, { tags: ['accidental'] })).toBe(false);
    expect(deleteNoteLocal(noteId)).toBe(false);
    expect(store$.notes.get()[noteId]).toEqual(tombstone);
    expect(store$.outbox.get()).toEqual([]);
  });
});

describe('local replica transactions', () => {
  it('publishes matching note and outbox state for create, update, and delete', async () => {
    store$.notes.set({});
    store$.outbox.set([]);
    store$.pendingPush.set(null);
    store$.conflicts.set({});
    store$.syncIssue.set({
      code: 'test_hold',
      message: 'Keep network reconciliation inert while observing local publications',
      affectedOpIds: [],
      recoveryKind: 'retry',
    });
    expect(await saveState()).toBe(true);

    const observed: {
      bodyMd: string;
      deleted: boolean;
      mutationType: SyncMutation['type'] | undefined;
      mutationBody: string | undefined;
    }[] = [];
    const dispose = store$.notes.onChange(({ value }) => {
      const changed = Object.values(value)[0];
      if (!changed) return;
      const queued = store$.outbox.get().find((item) => item.note.id === changed.id);
      observed.push({
        bodyMd: changed.bodyMd,
        deleted: changed.deletedAt !== null,
        mutationType: queued?.type,
        mutationBody: queued?.note.bodyMd,
      });
    });

    const created = createNoteLocal({ title: 'Created', bodyMd: 'created body' });
    expect(updateNoteLocal(created.id, { bodyMd: 'updated body' })).toBe(true);
    expect(deleteNoteLocal(created.id)).toBe(true);
    dispose();

    expect(observed).toEqual([
      {
        bodyMd: 'created body',
        deleted: false,
        mutationType: 'upsert',
        mutationBody: 'created body',
      },
      {
        bodyMd: 'updated body',
        deleted: false,
        mutationType: 'upsert',
        mutationBody: 'updated body',
      },
      {
        bodyMd: 'updated body',
        deleted: true,
        mutationType: 'delete',
        mutationBody: 'updated body',
      },
    ]);

    await updateReplicaForLease(openSessionLease()!, (current) => current);
    const persisted = JSON.parse(
      memory.values.get(stateStorageKeys.replica(ownerKeyFor(sessionA)))!,
    ) as { notes: Record<string, Note>; outbox: SyncMutation[] };
    expect(persisted.notes[created.id]?.deletedAt).not.toBeNull();
    expect(persisted.outbox[0]).toMatchObject({
      type: 'delete',
      note: { id: created.id, bodyMd: 'updated body' },
    });
  });

  it('publishes note and outbox together, then lets staging rescue a failed first save', async () => {
    const original = note(workspaceA, 'original');
    store$.notes.set({ [noteId]: original });
    store$.outbox.set([]);
    store$.pendingPush.set(null);
    store$.conflicts.set({});
    store$.syncIssue.set(null);
    expect(await saveState()).toBe(true);

    const replicaKey = stateStorageKeys.replica(ownerKeyFor(sessionA));
    memory.failSetOnceKey = replicaKey;
    const push = deferred<SyncPushResponse>();
    apiMock.pushPromise = push.promise;

    expect(updateNoteLocal(noteId, { bodyMd: 'optimistic and durable' })).toBe(true);
    const queued = store$.outbox.get()[0]!;
    expect(store$.notes.get()[noteId]?.bodyMd).toBe('optimistic and durable');
    expect(queued.note.bodyMd).toBe('optimistic and durable');

    const running = sync();
    await vi.waitFor(() => expect(apiMock.calls.some((call) => call.method === 'push')).toBe(true));

    const rescued = JSON.parse(memory.values.get(replicaKey)!) as {
      notes: Record<string, Note>;
      outbox: SyncMutation[];
      pendingPush: SyncMutation[] | null;
    };
    expect(rescued.notes[noteId]?.bodyMd).toBe('optimistic and durable');
    expect(rescued.outbox).toEqual([queued]);
    expect(rescued.pendingPush).toEqual([queued]);

    push.resolve(appliedResponse(workspaceA, [queued]));
    await running;
    expect(store$.notes.get()[noteId]?.bodyMd).toBe('optimistic and durable');
    expect(store$.outbox.get()).toEqual([]);
    expect(store$.pendingPush.get()).toBeNull();
  });
});

describe('authoritative direct-mutation commit fence', () => {
  it('retains a post-dispatch draft and collapses the next edit without losing fields', async () => {
    const original = note(workspaceA, 'Original body');
    store$.notes.set({ [noteId]: original });
    store$.outbox.set([]);
    store$.pendingPush.set(null);
    store$.conflicts.set({});
    // Keep the automatically scheduled sync inert while this test models the direct
    // response arriving between two synchronous local edits.
    store$.syncIssue.set({
      code: 'test_hold',
      message: 'Hold background sync for deterministic commit-fence coverage',
      affectedOpIds: [],
      recoveryKind: 'retry',
    });

    expect(updateNoteLocal(noteId, { title: 'Local title' })).toBe(true);
    const authoritativeUndo = {
      ...original,
      title: 'Server title',
      bodyMd: 'Server body',
      version: 4,
      updatedAt: '2026-07-15T12:00:00.000Z',
    };
    await updateReplicaForLease(openSessionLease()!, (current) =>
      mergeAuthoritativeNoteIfSafe(current, authoritativeUndo),
    );

    expect(store$.notes.get()[noteId]).toMatchObject({
      title: 'Local title',
      bodyMd: 'Original body',
      version: 3,
    });
    expect(store$.outbox.get()).toHaveLength(1);

    expect(updateNoteLocal(noteId, { bodyMd: 'Local body' })).toBe(true);
    expect(store$.notes.get()[noteId]).toMatchObject({
      title: 'Local title',
      bodyMd: 'Local body',
      version: 3,
    });
    expect(store$.outbox.get()).toHaveLength(1);
    expect(store$.outbox.get()[0]).toMatchObject({
      type: 'upsert',
      baseVersion: 3,
      note: { id: noteId, title: 'Local title', bodyMd: 'Local body' },
    });
    expect(await saveState()).toBe(true);
  });
});

describe('manual durable sync recovery', () => {
  it('hydrates a terminal issue and suppresses every automatic network retry', async () => {
    store$.conflicts.set({});
    store$.syncIssue.set({
      code: 'invalid_sync_response',
      message: 'Malformed response',
      affectedOpIds: [],
      recoveryKind: 'retry',
    });
    expect(await saveState()).toBe(true);

    store$.syncIssue.set(null);
    await loadState();
    expect(store$.syncIssue.get()?.code).toBe('invalid_sync_response');
    apiMock.calls = [];

    await sync();
    await sync();

    expect(apiMock.calls).toEqual([]);
    expect(store$.status.get()).toBe('error');
  });

  it('rekeys only the operation named by an idempotency collision', async () => {
    const first = localMutation('first', 'op-first');
    const second = {
      ...localMutation('second', 'op-second'),
      note: { ...localMutation('second', 'op-second').note, id: secondNoteId },
    };
    store$.conflicts.set({});
    store$.notes.set({
      [noteId]: note(workspaceA, 'first', 1),
      [secondNoteId]: { ...note(workspaceA, 'second', 1), id: secondNoteId },
    });
    store$.outbox.set([first, second]);
    store$.pendingPush.set([first, second]);
    store$.syncIssue.set({
      code: 'idempotency_key_reused',
      message: 'First operation id is already bound',
      affectedOpIds: [first.opId],
      recoveryKind: 'rekey',
    });
    expect(await saveState()).toBe(true);
    const push = deferred<SyncPushResponse>();
    apiMock.pushPromise = push.promise;

    expect(await recoverSyncIssue()).toBe(true);
    await vi.waitFor(() => expect(apiMock.calls.some((call) => call.method === 'push')).toBe(true));
    const body = apiMock.calls.find((call) => call.method === 'push')!.body!;
    expect(body.mutations[0]).toEqual({ ...first, opId: expect.any(String) });
    expect(body.mutations[0]?.opId).not.toBe(first.opId);
    expect(body.mutations[1]).toEqual(second);
    expect(store$.outbox.get()).toEqual(body.mutations);
    expect(store$.pendingPush.get()).toEqual(body.mutations);
    expect(store$.syncIssue.get()).toBeNull();

    const running = sync();
    push.resolve(appliedResponse(workspaceA, body.mutations));
    await running;
  });

  it('rekeys the whole pending batch when the collision names no operation', async () => {
    const first = localMutation('first', 'op-first');
    const second = {
      ...localMutation('second', 'op-second'),
      note: { ...localMutation('second', 'op-second').note, id: secondNoteId },
    };
    store$.conflicts.set({});
    store$.notes.set({
      [noteId]: note(workspaceA, 'first', 1),
      [secondNoteId]: { ...note(workspaceA, 'second', 1), id: secondNoteId },
    });
    store$.outbox.set([first, second]);
    store$.pendingPush.set([first, second]);
    store$.syncIssue.set({
      code: 'idempotency_key_reused',
      message: 'Pending operation ids are already bound',
      affectedOpIds: [first.opId, second.opId],
      recoveryKind: 'rekey',
    });
    expect(await saveState()).toBe(true);
    const push = deferred<SyncPushResponse>();
    apiMock.pushPromise = push.promise;

    expect(await recoverSyncIssue()).toBe(true);
    await vi.waitFor(() => expect(apiMock.calls.some((call) => call.method === 'push')).toBe(true));
    const body = apiMock.calls.find((call) => call.method === 'push')!.body!;
    expect(body.mutations.map((item) => item.opId)).not.toContain(first.opId);
    expect(body.mutations.map((item) => item.opId)).not.toContain(second.opId);
    expect(body.mutations.map((item) => item.note)).toEqual([first.note, second.note]);

    const running = sync();
    push.resolve(appliedResponse(workspaceA, body.mutations));
    await running;
  });

  it('resets only the cursor for invalid-cursor recovery', async () => {
    store$.conflicts.set({});
    store$.syncCursor.set('invalid-cursor');
    store$.syncIssue.set({
      code: 'invalid_sync_cursor',
      message: 'Cursor is invalid',
      affectedOpIds: [],
      recoveryKind: 'reset-cursor',
    });
    expect(await saveState()).toBe(true);

    expect(await recoverSyncIssue()).toBe(true);
    await sync();

    expect(store$.syncCursor.get()).toBe('');
    expect(store$.syncIssue.get()).toBeNull();
  });

  it('restages the current outbox instead of replaying an invalid older pending request', async () => {
    const oldPending = localMutation('old invalid payload', 'op-old');
    const newer = localMutation('newer valid payload', 'op-newer');
    store$.conflicts.set({});
    store$.notes.set({ [noteId]: note(workspaceA, newer.note.bodyMd, 1) });
    store$.outbox.set([newer]);
    store$.pendingPush.set([oldPending]);
    store$.syncIssue.set({
      code: 'invalid_local_sync_mutation',
      message: 'Edit the note and restage',
      affectedOpIds: [oldPending.opId],
      recoveryKind: 'restage',
    });
    expect(await saveState()).toBe(true);
    const push = deferred<SyncPushResponse>();
    apiMock.pushPromise = push.promise;

    expect(await recoverSyncIssue()).toBe(true);
    await vi.waitFor(() => expect(apiMock.calls.some((call) => call.method === 'push')).toBe(true));
    const body = apiMock.calls.find((call) => call.method === 'push')!.body!;
    expect(body.mutations).toEqual([newer]);
    expect(store$.pendingPush.get()).toEqual([newer]);
    expect(store$.outbox.get()).toEqual([newer]);
    expect(store$.syncIssue.get()).toBeNull();

    const running = sync();
    push.resolve(appliedResponse(workspaceA, body.mutations));
    await running;
  });

  it('generic retry preserves the exact durable pending payload', async () => {
    const pending = localMutation('exact payload', 'op-exact');
    store$.conflicts.set({});
    store$.notes.set({ [noteId]: note(workspaceA, pending.note.bodyMd, 1) });
    store$.outbox.set([pending]);
    store$.pendingPush.set([pending]);
    store$.syncIssue.set({
      code: 'invalid_sync_response',
      message: 'Malformed response',
      affectedOpIds: [pending.opId],
      recoveryKind: 'retry',
    });
    expect(await saveState()).toBe(true);
    const push = deferred<SyncPushResponse>();
    apiMock.pushPromise = push.promise;

    expect(await recoverSyncIssue()).toBe(true);
    await vi.waitFor(() => expect(apiMock.calls.some((call) => call.method === 'push')).toBe(true));
    const body = apiMock.calls.find((call) => call.method === 'push')!.body!;
    expect(body.mutations).toEqual([pending]);
    expect(store$.pendingPush.get()).toEqual([pending]);

    const running = sync();
    push.resolve(appliedResponse(workspaceA, body.mutations));
    await running;
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
