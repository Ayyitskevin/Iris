import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, SyncMutation } from '@iris/shared';

const memory = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failSetKey: null as string | null,
  failSetOnceKey: null as string | null,
  mutateThenThrowSetKey: null as string | null,
  failAfterBlockSetKey: null as string | null,
  failRemoveKey: null as string | null,
  mutateThenThrowRemoveKey: null as string | null,
  removeCalls: [] as string[],
  block: null as { key: string; promise: Promise<void> } | null,
}));

vi.mock('./storage', () => ({
  storage: {
    get: async (key: string) => memory.values.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (memory.failSetOnceKey === key) {
        memory.failSetOnceKey = null;
        throw new Error('injected one-time write failure');
      }
      if (memory.failSetKey === key) throw new Error('injected write failure');
      const block = memory.block;
      if (block?.key === key) {
        memory.block = null;
        await block.promise;
      }
      if (memory.failAfterBlockSetKey === key) {
        memory.failAfterBlockSetKey = null;
        throw new Error('injected failure after blocked write resumes');
      }
      memory.values.set(key, value);
      if (memory.mutateThenThrowSetKey === key) {
        memory.mutateThenThrowSetKey = null;
        throw new Error('injected post-write failure');
      }
    },
    remove: async (key: string) => {
      memory.removeCalls.push(key);
      if (memory.failRemoveKey === key) throw new Error('injected remove failure');
      memory.values.delete(key);
      if (memory.mutateThenThrowRemoveKey === key) {
        memory.mutateThenThrowRemoveKey = null;
        throw new Error('injected post-remove failure');
      }
    },
  },
}));

import {
  adoptSession,
  applyReplicaForLease,
  expireSessionIfCurrent,
  loadState,
  openSessionLease,
  ownerKeyFor,
  retryPendingSessionPersistence,
  saveState,
  signOutSession,
  stateStorageKeys,
  store$,
  updateReplicaForLease,
  type Session,
} from './store';

const workspaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const noteAId = '33333333-3333-4333-8333-333333333333';
const noteBId = '44444444-4444-4444-8444-444444444444';

const sessionA: Session = {
  token: 'token-A-secret',
  userId: userA,
  workspaceId: workspaceA,
  email: 'a@example.com',
  displayName: 'A',
};

const sessionB: Session = {
  token: 'token-B-secret',
  userId: userB,
  workspaceId: workspaceB,
  email: 'b@example.com',
  displayName: 'B',
};

function note(id: string, workspaceId: string, bodyMd: string): Note {
  return {
    id,
    workspaceId,
    title: bodyMd,
    bodyMd,
    folder: null,
    tags: [],
    version: 1,
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
    deletedAt: null,
  };
}

function mutation(id: string, opId: string, bodyMd: string): SyncMutation {
  return {
    opId,
    type: 'upsert',
    note: { id, title: bodyMd, bodyMd, folder: null, tags: [] },
    baseVersion: 1,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  memory.values.clear();
  memory.failSetKey = null;
  memory.failSetOnceKey = null;
  memory.mutateThenThrowSetKey = null;
  memory.failAfterBlockSetKey = null;
  memory.failRemoveKey = null;
  memory.mutateThenThrowRemoveKey = null;
  memory.removeCalls = [];
  memory.block = null;
  await loadState();
});

describe('owner-partitioned state', () => {
  it('migrates attributable v1 drafts while resetting global cursor and device identity', async () => {
    const draft = note(noteAId, workspaceA, 'offline A draft');
    const pending = mutation(noteAId, 'op-A', draft.bodyMd);
    memory.values.set(
      stateStorageKeys.legacy,
      JSON.stringify({
        session: sessionA,
        notes: { [draft.id]: draft },
        syncCursor: 'cursor-A',
        deviceId: 'device-legacy-A',
        outbox: [pending],
      }),
    );

    await loadState();

    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.notes.get()).toEqual({ [draft.id]: draft });
    expect(store$.outbox.get()).toEqual([pending]);
    expect(store$.syncCursor.get()).toBe('');
    expect(store$.deviceId.get()).not.toBe('device-legacy-A');
    expect(memory.values.has(stateStorageKeys.legacy)).toBe(false);

    const ownerKey = ownerKeyFor(sessionA);
    const replicaRaw = memory.values.get(stateStorageKeys.replica(ownerKey))!;
    const sessionRaw = memory.values.get(stateStorageKeys.session)!;
    const recoveryRaw = memory.values.get(stateStorageKeys.recovery)!;
    expect(sessionRaw).toContain(sessionA.token);
    expect(replicaRaw).not.toContain(sessionA.token);
    expect(recoveryRaw).not.toContain(sessionA.token);
  });

  it('quarantines mixed-workspace legacy data instead of attaching it to B', async () => {
    const a = note(noteAId, workspaceA, 'A private');
    const b = note(noteBId, workspaceB, 'B private');
    const opA = mutation(noteAId, 'op-A', a.bodyMd);
    const opB = mutation(noteBId, 'op-B', b.bodyMd);
    memory.values.set(
      stateStorageKeys.legacy,
      JSON.stringify({
        session: sessionB,
        notes: { [a.id]: a, [b.id]: b },
        syncCursor: 'possibly-A-cursor',
        deviceId: 'device-B',
        outbox: [opA, opB],
      }),
    );

    await loadState();

    expect(store$.notes.get()).toEqual({ [b.id]: b });
    expect(store$.outbox.get()).toEqual([opB]);
    expect(store$.syncCursor.get()).toBe('');
    const recovery = JSON.parse(memory.values.get(stateStorageKeys.recovery)!) as {
      notes: Record<string, Note>;
      outbox: SyncMutation[];
    };
    expect(Object.keys(recovery.notes).sort()).toEqual([noteAId, noteBId].sort());
    expect(recovery.outbox).toEqual([opA, opB]);
  });

  it('quarantines ownerless local notes, cursor, and device identity', async () => {
    const local = note(noteAId, 'local', 'unknown local draft');
    const b = note(noteBId, workspaceB, 'B attributable');
    const localOp = mutation(noteAId, 'op-local', local.bodyMd);
    const bOp = mutation(noteBId, 'op-B', b.bodyMd);
    memory.values.set(
      stateStorageKeys.legacy,
      JSON.stringify({
        session: sessionB,
        notes: { [local.id]: local, [b.id]: b },
        syncCursor: 'ownerless-cursor',
        deviceId: 'ownerless-device',
        outbox: [localOp, bOp],
      }),
    );

    await loadState();

    expect(store$.notes.get()).toEqual({ [b.id]: b });
    expect(store$.outbox.get()).toEqual([bOp]);
    expect(store$.syncCursor.get()).toBe('');
    expect(store$.deviceId.get()).not.toBe('ownerless-device');
    const recovery = JSON.parse(memory.values.get(stateStorageKeys.recovery)!) as {
      notes: Record<string, Note>;
      outbox: SyncMutation[];
    };
    expect(recovery.notes[noteAId]).toEqual(local);
    expect(recovery.outbox).toContainEqual(localOp);
  });

  it('materializes legacy A even when a valid v2 B session is already active', async () => {
    const a = note(noteAId, workspaceA, 'legacy A');
    memory.values.set(stateStorageKeys.session, JSON.stringify(sessionB));
    memory.values.set(
      stateStorageKeys.legacy,
      JSON.stringify({
        session: sessionA,
        notes: { [a.id]: a },
        syncCursor: 'global',
        deviceId: 'global',
        outbox: [mutation(noteAId, 'op-A', a.bodyMd)],
      }),
    );

    await loadState();

    expect(store$.session.get()).toEqual(sessionB);
    expect(store$.notes.get()).toEqual({});
    const replicaA = JSON.parse(
      memory.values.get(stateStorageKeys.replica(ownerKeyFor(sessionA)))!,
    ) as { notes: Record<string, Note>; syncCursor: string };
    expect(replicaA.notes[noteAId]).toEqual(a);
    expect(replicaA.syncCursor).toBe('');
  });

  it('replaces malformed partial v2 session and replica before retiring v1', async () => {
    const a = note(noteAId, workspaceA, 'recover A');
    memory.values.set(stateStorageKeys.session, '{malformed');
    memory.values.set(stateStorageKeys.replica(ownerKeyFor(sessionA)), '{corrupt');
    memory.values.set(
      stateStorageKeys.legacy,
      JSON.stringify({
        session: sessionA,
        notes: { [a.id]: a },
        syncCursor: 'global',
        deviceId: 'global',
        outbox: [],
      }),
    );

    await loadState();

    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.notes.get()[noteAId]).toEqual(a);
    expect(memory.values.has(stateStorageKeys.migration)).toBe(true);
    expect(memory.values.has(stateStorageKeys.legacy)).toBe(false);
  });

  it('quarantines a valid but poisoned unmarked v2 migration replica', async () => {
    const local = note(noteAId, 'local', 'ownerless local');
    const poisoned = {
      version: 2,
      ownerKey: ownerKeyFor(sessionB),
      userId: sessionB.userId,
      workspaceId: sessionB.workspaceId,
      notes: {
        [noteAId]: { ...local, workspaceId: sessionB.workspaceId },
      },
      syncCursor: 'global-cursor',
      deviceId: 'global-device',
      outbox: [mutation(noteAId, 'op-local', local.bodyMd)],
      conflicts: {},
    };
    memory.values.set(
      stateStorageKeys.legacy,
      JSON.stringify({
        session: sessionB,
        notes: { [local.id]: local },
        syncCursor: 'global-cursor',
        deviceId: 'global-device',
        outbox: [mutation(noteAId, 'op-local', local.bodyMd)],
      }),
    );
    memory.values.set(stateStorageKeys.replica(ownerKeyFor(sessionB)), JSON.stringify(poisoned));

    await loadState();

    expect(store$.session.get()).toEqual(sessionB);
    expect(store$.notes.get()).toEqual({});
    expect(store$.outbox.get()).toEqual([]);
    expect(store$.syncCursor.get()).toBe('');
    expect(store$.deviceId.get()).not.toBe('global-device');
    const recovery = JSON.parse(memory.values.get(stateStorageKeys.recovery)!) as {
      unmarkedReplica: { ownerKey: string; raw: string };
    };
    expect(recovery.unmarkedReplica.ownerKey).toBe(ownerKeyFor(sessionB));
    expect(recovery.unmarkedReplica.raw).toBe(JSON.stringify(poisoned));
  });

  it('keeps sessionless legacy drafts in recovery and reveals them to no signer', async () => {
    const a = note(noteAId, workspaceA, 'owner unknown');
    memory.values.set(
      stateStorageKeys.legacy,
      JSON.stringify({
        session: null,
        notes: { [a.id]: a },
        syncCursor: 'unknown-cursor',
        deviceId: 'unknown-device',
        outbox: [mutation(noteAId, 'op-unknown', a.bodyMd)],
      }),
    );

    await loadState();

    expect(store$.session.get()).toBeNull();
    expect(store$.notes.get()).toEqual({});
    const recovery = JSON.parse(memory.values.get(stateStorageKeys.recovery)!) as {
      notes: Record<string, Note>;
    };
    expect(recovery.notes[noteAId]).toEqual(a);
    expect(memory.values.has(stateStorageKeys.migration)).toBe(true);
  });

  it('leaves v1 retryable when migration persistence fails', async () => {
    const raw = JSON.stringify({
      session: sessionA,
      notes: { [noteAId]: note(noteAId, workspaceA, 'retry me') },
      syncCursor: '',
      deviceId: 'device-A',
      outbox: [],
    });
    memory.values.set(stateStorageKeys.legacy, raw);
    memory.failSetKey = stateStorageKeys.recovery;

    await loadState();

    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('error');
    expect(memory.values.get(stateStorageKeys.legacy)).toBe(raw);
    expect(memory.values.has(stateStorageKeys.migration)).toBe(false);

    memory.failSetKey = null;
    await loadState();
    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('retry me');
  });

  it('does not let a malformed migration marker retire v1 state', async () => {
    const a = note(noteAId, workspaceA, 'marker retry');
    memory.values.set(stateStorageKeys.migration, '{partial');
    memory.values.set(
      stateStorageKeys.legacy,
      JSON.stringify({
        session: sessionA,
        notes: { [a.id]: a },
        syncCursor: 'global',
        deviceId: 'global',
        outbox: [],
      }),
    );

    await loadState();

    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.notes.get()[noteAId]).toEqual(a);
    expect(memory.values.has(stateStorageKeys.legacy)).toBe(false);
  });

  it('loads a v2 replica written before pending request staging existed', async () => {
    const ownerKey = ownerKeyFor(sessionA);
    memory.values.set(stateStorageKeys.session, JSON.stringify(sessionA));
    memory.values.set(
      stateStorageKeys.replica(ownerKey),
      JSON.stringify({
        version: 2,
        ownerKey,
        userId: sessionA.userId,
        workspaceId: sessionA.workspaceId,
        notes: {},
        syncCursor: 'legacy-v2-cursor',
        deviceId: 'legacy-v2-device',
        outbox: [],
        conflicts: {},
      }),
    );

    await loadState();

    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.pendingPush.get()).toBeNull();
    expect(store$.syncIssue.get()).toBeNull();
    expect(store$.syncCursor.get()).toBe('legacy-v2-cursor');
  });

  it('switches owners atomically and restores each private replica', async () => {
    await adoptSession(sessionA);
    const deviceA = store$.deviceId.get();
    const a = note(noteAId, workspaceA, 'A only');
    const opA = mutation(noteAId, 'op-A', a.bodyMd);
    store$.notes.set({ [a.id]: a });
    store$.outbox.set([opA]);
    store$.syncCursor.set('cursor-A');
    expect(await saveState()).toBe(true);

    await adoptSession(sessionB);
    const deviceB = store$.deviceId.get();
    expect(store$.notes.get()).toEqual({});
    expect(store$.outbox.get()).toEqual([]);
    expect(store$.syncCursor.get()).toBe('');
    expect(deviceB).not.toBe(deviceA);

    const b = note(noteBId, workspaceB, 'B only');
    store$.notes.set({ [b.id]: b });
    store$.syncCursor.set('cursor-B');
    expect(await saveState()).toBe(true);

    await adoptSession({ ...sessionA, token: 'token-A-refreshed' });
    expect(store$.notes.get()).toEqual({ [a.id]: a });
    expect(store$.outbox.get()).toEqual([opA]);
    expect(store$.syncCursor.get()).toBe('cursor-A');
    expect(store$.deviceId.get()).toBe(deviceA);
  });

  it('keeps an exact pending request durable and scoped to its owner', async () => {
    await adoptSession(sessionA);
    const a = note(noteAId, workspaceA, 'A staged request');
    const opA = mutation(noteAId, 'op-A-staged', a.bodyMd);
    store$.notes.set({ [a.id]: a });
    store$.outbox.set([opA]);
    store$.pendingPush.set([opA]);
    expect(await saveState()).toBe(true);

    // Prove hydration restores the durable request instead of trusting current memory.
    store$.pendingPush.set(null);
    await loadState();
    expect(store$.pendingPush.get()).toEqual([opA]);

    await adoptSession(sessionB);
    expect(store$.pendingPush.get()).toBeNull();
    await adoptSession({ ...sessionA, token: 'token-A-return' });
    expect(store$.pendingPush.get()).toEqual([opA]);
    expect(store$.outbox.get()).toEqual([opA]);
  });

  it('hydrates a durable sync issue only for its owning replica', async () => {
    await adoptSession(sessionA);
    const a = note(noteAId, workspaceA, 'A held request');
    const opA = mutation(noteAId, 'op-A-held', a.bodyMd);
    const issue = {
      code: 'idempotency_key_reused',
      message: 'Operation id is already bound',
      affectedOpIds: [opA.opId],
      recoveryKind: 'rekey' as const,
    };
    store$.notes.set({ [a.id]: a });
    store$.outbox.set([opA]);
    store$.pendingPush.set([opA]);
    store$.syncIssue.set(issue);
    expect(await saveState()).toBe(true);

    store$.syncIssue.set(null);
    await loadState();
    expect(store$.syncIssue.get()).toEqual(issue);

    await adoptSession(sessionB);
    expect(store$.syncIssue.get()).toBeNull();
    await adoptSession({ ...sessionA, token: 'token-A-return' });
    expect(store$.syncIssue.get()).toEqual(issue);
    expect(store$.pendingPush.get()).toEqual([opA]);
  });

  it('rejects a persisted sync issue with an invalid recovery contract', async () => {
    const ownerKey = ownerKeyFor(sessionA);
    memory.values.set(stateStorageKeys.session, JSON.stringify(sessionA));
    memory.values.set(
      stateStorageKeys.replica(ownerKey),
      JSON.stringify({
        version: 2,
        ownerKey,
        userId: sessionA.userId,
        workspaceId: sessionA.workspaceId,
        notes: {},
        syncCursor: '',
        deviceId: 'device-A',
        outbox: [],
        pendingPush: null,
        syncIssue: {
          code: 'broken',
          message: 'Broken issue',
          affectedOpIds: ['op-1', 'op-1'],
          recoveryKind: 'invented',
        },
        conflicts: {},
      }),
    );

    await loadState();

    expect(store$.session.get()).toBeNull();
    expect(store$.syncIssue.get()).toBeNull();
    expect(store$.status.get()).toBe('error');
  });

  it('signs out without deleting drafts and restores them on the next A session', async () => {
    await adoptSession(sessionA);
    const a = note(noteAId, workspaceA, 'survives signout');
    const opA = mutation(noteAId, 'op-A', a.bodyMd);
    store$.notes.set({ [a.id]: a });
    store$.outbox.set([opA]);
    expect(await saveState()).toBe(true);

    await signOutSession();
    expect(store$.session.get()).toBeNull();
    expect(store$.notes.get()).toEqual({});
    const tombstone = memory.values.get(stateStorageKeys.session)!;
    expect(tombstone).not.toContain(sessionA.token);
    expect(JSON.parse(tombstone)).toMatchObject({ state: 'signed-out', reason: 'sign-out' });

    await adoptSession({ ...sessionA, token: 'token-A-new' });
    expect(store$.notes.get()).toEqual({ [a.id]: a });
    expect(store$.outbox.get()).toEqual([opA]);
  });

  it('does not report sign-out when the credential tombstone cannot be written', async () => {
    await adoptSession(sessionA);
    const a = note(noteAId, workspaceA, 'latest before signout');
    store$.notes.set({ [a.id]: a });
    memory.failSetOnceKey = stateStorageKeys.session;

    await expect(signOutSession()).rejects.toThrow('Could not persist');

    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.notes.get()[noteAId]).toEqual(a);
    expect(memory.values.get(stateStorageKeys.session)).toBe(JSON.stringify(sessionA));
    const persisted = JSON.parse(
      memory.values.get(stateStorageKeys.replica(ownerKeyFor(sessionA)))!,
    ) as { notes: Record<string, Note> };
    expect(persisted.notes[noteAId]).toEqual(a);
  });

  it('treats mutate-then-throw tombstone storage as a committed sign-out', async () => {
    await adoptSession(sessionA);
    memory.mutateThenThrowSetKey = stateStorageKeys.session;

    await signOutSession();

    expect(store$.session.get()).toBeNull();
    expect(JSON.parse(memory.values.get(stateStorageKeys.session)!)).toMatchObject({
      state: 'signed-out',
      reason: 'sign-out',
    });
  });

  it('flushes the replica before replacing the credential with a tombstone', async () => {
    await adoptSession(sessionA);
    const unsaved = note(noteAId, workspaceA, 'must flush first');
    store$.notes.set({ [unsaved.id]: unsaved });
    memory.failSetKey = stateStorageKeys.replica(ownerKeyFor(sessionA));

    await expect(signOutSession()).rejects.toThrow('Could not persist');

    expect(store$.session.get()).toEqual(sessionA);
    expect(memory.values.get(stateStorageKeys.session)).toBe(JSON.stringify(sessionA));
  });

  it('keeps A active when the B credential commit fails before mutation', async () => {
    await adoptSession(sessionA);
    memory.failSetOnceKey = stateStorageKeys.session;

    await expect(adoptSession(sessionB)).rejects.toThrow('Could not persist');

    expect(store$.session.get()).toEqual(sessionA);
    expect(memory.values.get(stateStorageKeys.session)).toBe(JSON.stringify(sessionA));
  });

  it('accepts a B credential write that commits before its storage call throws', async () => {
    await adoptSession(sessionA);
    memory.mutateThenThrowSetKey = stateStorageKeys.session;

    await adoptSession(sessionB);

    expect(store$.session.get()).toEqual(sessionB);
    expect(memory.values.get(stateStorageKeys.session)).toBe(JSON.stringify(sessionB));
  });

  it('retries failed empty-replica creation without a memory-only cache hit', async () => {
    await adoptSession(sessionA);
    const replicaBKey = stateStorageKeys.replica(ownerKeyFor(sessionB));
    memory.failSetKey = replicaBKey;

    await expect(adoptSession(sessionB)).rejects.toThrow('Could not persist');
    expect(store$.session.get()).toEqual(sessionA);
    expect(memory.values.has(replicaBKey)).toBe(false);

    memory.failSetKey = null;
    await adoptSession(sessionB);
    expect(store$.session.get()).toEqual(sessionB);
    expect(memory.values.has(replicaBKey)).toBe(true);
  });

  it('makes a 401 durable by replacing the credential with a boot tombstone', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;

    expect(await expireSessionIfCurrent(lease)).toBe(true);
    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('auth-required');
    const tombstone = memory.values.get(stateStorageKeys.session)!;
    expect(tombstone).not.toContain(sessionA.token);
    expect(JSON.parse(tombstone)).toMatchObject({ state: 'signed-out', reason: 'rejected' });

    await loadState();
    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('auth-required');
    expect(memory.values.get(stateStorageKeys.session)).toBe(tombstone);
  });

  it('falls back to verified credential removal when the 401 tombstone write fails', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    memory.failSetOnceKey = stateStorageKeys.session;

    expect(await expireSessionIfCurrent(lease)).toBe(true);
    expect(store$.session.get()).toBeNull();
    expect(memory.values.has(stateStorageKeys.session)).toBe(false);
  });

  it('fences a current 401 even when the active replica is corrupt', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    store$.notes.set({ [noteBId]: note(noteBId, workspaceB, 'foreign corruption') });

    expect(await expireSessionIfCurrent(lease)).toBe(true);

    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('auth-required');
    expect(memory.values.get(stateStorageKeys.session)).not.toContain(sessionA.token);
  });

  it('distinguishes total 401 persistence failure and retries after storage recovers', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    memory.failSetKey = stateStorageKeys.session;
    memory.failRemoveKey = stateStorageKeys.session;

    await expect(expireSessionIfCurrent(lease)).rejects.toThrow(
      'could not be cleared from durable storage',
    );
    expect(store$.session.get()).toBeNull();
    expect(memory.values.get(stateStorageKeys.session)).toBe(JSON.stringify(sessionA));

    memory.failSetKey = null;
    memory.failRemoveKey = null;
    expect(await retryPendingSessionPersistence()).toBe(true);
    expect(memory.values.get(stateStorageKeys.session)).not.toContain(sessionA.token);
  });

  it('still clears a rejected credential when its final replica flush fails', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    memory.failSetKey = stateStorageKeys.replica(ownerKeyFor(sessionA));

    expect(await expireSessionIfCurrent(lease)).toBe(true);
    expect(store$.session.get()).toBeNull();
    expect(memory.values.get(stateStorageKeys.session)).not.toContain(sessionA.token);
  });

  it('accepts a replica write that commits before its storage call throws', async () => {
    await adoptSession(sessionA);
    const a = note(noteAId, workspaceA, 'committed despite throw');
    store$.notes.set({ [a.id]: a });
    memory.mutateThenThrowSetKey = stateStorageKeys.replica(ownerKeyFor(sessionA));

    expect(await saveState()).toBe(true);
    const persisted = JSON.parse(
      memory.values.get(stateStorageKeys.replica(ownerKeyFor(sessionA)))!,
    ) as { notes: Record<string, Note> };
    expect(persisted.notes[noteAId]).toEqual(a);
  });

  it('does not let an old A lease expire the current B session', async () => {
    await adoptSession(sessionA);
    const leaseA = openSessionLease()!;
    await adoptSession(sessionB);

    expect(await expireSessionIfCurrent(leaseA)).toBe(false);
    expect(store$.session.get()).toEqual(sessionB);
  });

  it('rejects a delayed A restore write after B becomes active', async () => {
    await adoptSession(sessionA);
    const leaseA = openSessionLease()!;
    await adoptSession(sessionB);

    await expect(
      updateReplicaForLease(leaseA, (current) => ({
        ...current,
        notes: { ...current.notes, [noteAId]: note(noteAId, workspaceA, 'late restore') },
      })),
    ).rejects.toThrow('Session changed');
    expect(store$.session.get()).toEqual(sessionB);
    expect(store$.notes.get()).toEqual({});
  });

  it('finishes an in-flight A commit under A while fencing the switched B projection', async () => {
    await adoptSession(sessionA);
    const leaseA = openSessionLease()!;
    const keyA = stateStorageKeys.replica(ownerKeyFor(sessionA));
    const gate = deferred();
    memory.block = { key: keyA, promise: gate.promise };
    const draftA = note(noteAId, workspaceA, 'in-flight A draft');
    const queuedA = mutation(noteAId, 'op-in-flight-a', draftA.bodyMd);
    const appliedA = applyReplicaForLease(leaseA, (current) => ({
      next: {
        ...current,
        notes: { ...current.notes, [noteAId]: draftA },
        outbox: [queuedA],
      },
      result: undefined,
    }));
    await vi.waitFor(() => expect(memory.block).toBeNull());

    const switching = adoptSession(sessionB);
    await vi.waitFor(() => expect(leaseA.signal.aborted).toBe(true));
    gate.resolve();
    await expect(appliedA.durable).rejects.toThrow('Session changed');
    await switching;

    expect(store$.session.get()).toEqual(sessionB);
    expect(store$.notes.get()).toEqual({});
    expect(store$.outbox.get()).toEqual([]);
    const persistedA = JSON.parse(memory.values.get(keyA)!) as {
      notes: Record<string, Note>;
      outbox: SyncMutation[];
    };
    expect(persistedA.notes[noteAId]?.bodyMd).toBe(draftA.bodyMd);
    expect(persistedA.outbox).toEqual([queuedA]);

    await adoptSession({ ...sessionA, token: 'token-A-return' });
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe(draftA.bodyMd);
    expect(store$.outbox.get()).toEqual([queuedA]);
  });

  it('rolls back a replica transition when its durable write fails', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    const original = note(noteAId, workspaceA, 'original');
    store$.notes.set({ [original.id]: original });
    expect(await saveState()).toBe(true);
    memory.failSetKey = stateStorageKeys.replica(ownerKeyFor(sessionA));

    await expect(
      updateReplicaForLease(lease, (current) => ({
        ...current,
        notes: {
          ...current.notes,
          [noteAId]: note(noteAId, workspaceA, 'must roll back'),
        },
      })),
    ).rejects.toThrow('Could not persist');
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('original');

    memory.failSetKey = null;
    await adoptSession(sessionB);
    await adoptSession(sessionA);
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('original');
  });

  it('retains an optimistic apply after failure and rescues its exact pair later', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    const original = note(noteAId, workspaceA, 'original');
    store$.notes.set({ [noteAId]: original });
    expect(await saveState()).toBe(true);

    const key = stateStorageKeys.replica(ownerKeyFor(sessionA));
    memory.failSetOnceKey = key;
    const optimistic = note(noteAId, workspaceA, 'optimistic');
    const queued = mutation(noteAId, 'op-optimistic', optimistic.bodyMd);
    const applied = applyReplicaForLease(lease, (current) => ({
      next: {
        ...current,
        notes: { ...current.notes, [noteAId]: optimistic },
        outbox: [queued],
      },
      result: 'visible',
    }));

    expect(applied.result).toBe('visible');
    await expect(applied.durable).rejects.toThrow('Could not persist');
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe(optimistic.bodyMd);
    expect(store$.outbox.get()).toEqual([queued]);
    expect(JSON.parse(memory.values.get(key)!).notes[noteAId].bodyMd).toBe(original.bodyMd);

    await updateReplicaForLease(lease, (current) => current);
    const rescued = JSON.parse(memory.values.get(key)!) as {
      notes: Record<string, Note>;
      outbox: SyncMutation[];
    };
    expect(rescued.notes[noteAId]?.bodyMd).toBe(optimistic.bodyMd);
    expect(rescued.outbox).toEqual([queued]);
  });

  it('rolls back pending request staging when its durable write fails', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    const a = note(noteAId, workspaceA, 'not dispatched');
    const opA = mutation(noteAId, 'op-not-dispatched', a.bodyMd);
    store$.notes.set({ [a.id]: a });
    store$.outbox.set([opA]);
    expect(await saveState()).toBe(true);
    memory.failSetKey = stateStorageKeys.replica(ownerKeyFor(sessionA));

    await expect(
      updateReplicaForLease(lease, (current) => ({ ...current, pendingPush: [opA] })),
    ).rejects.toThrow('Could not persist');

    expect(store$.pendingPush.get()).toBeNull();
    expect(store$.outbox.get()).toEqual([opA]);
  });

  it('makes a memory-only pending request durable through an identity replica commit', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    const original = note(noteAId, workspaceA, 'first edit');
    const staged = mutation(noteAId, 'op-staged', original.bodyMd);
    store$.notes.set({ [original.id]: original });
    store$.outbox.set([staged]);
    expect(await saveState()).toBe(true);

    const key = stateStorageKeys.replica(ownerKeyFor(sessionA));
    const gate = deferred();
    memory.block = { key, promise: gate.promise };
    memory.failAfterBlockSetKey = key;
    const staging = updateReplicaForLease(lease, (current) => ({
      ...current,
      pendingPush: [staged],
    }));
    await vi.waitFor(() => expect(memory.block).toBeNull());

    const newer = note(noteAId, workspaceA, 'newer concurrent edit');
    const newerMutation = mutation(noteAId, 'op-newer', newer.bodyMd);
    store$.notes.set({ [newer.id]: newer });
    store$.outbox.set([newerMutation]);
    gate.resolve();
    await expect(staging).rejects.toThrow('Could not persist');

    const beforeConfirmation = JSON.parse(memory.values.get(key)!) as {
      pendingPush: SyncMutation[] | null;
    };
    expect(beforeConfirmation.pendingPush).toBeNull();
    expect(store$.pendingPush.get()).toEqual([staged]);

    await updateReplicaForLease(lease, (current) => current);

    const confirmed = JSON.parse(memory.values.get(key)!) as {
      pendingPush: SyncMutation[] | null;
      outbox: SyncMutation[];
    };
    expect(confirmed.pendingPush).toEqual([staged]);
    expect(confirmed.outbox).toEqual([newerMutation]);
  });

  it('serializes owner saves so an older slow write cannot win', async () => {
    await adoptSession(sessionA);
    const first = note(noteAId, workspaceA, 'first');
    store$.notes.set({ [first.id]: first });
    const gate = deferred();
    memory.block = {
      key: stateStorageKeys.replica(ownerKeyFor(sessionA)),
      promise: gate.promise,
    };
    const firstSave = saveState();

    const second = note(noteAId, workspaceA, 'second');
    store$.notes.set({ [second.id]: second });
    const secondSave = saveState();
    gate.resolve();
    await Promise.all([firstSave, secondSave]);

    const persisted = JSON.parse(
      memory.values.get(stateStorageKeys.replica(ownerKeyFor(sessionA)))!,
    ) as { notes: Record<string, Note> };
    expect(persisted.notes[noteAId]?.bodyMd).toBe('second');
  });

  it('queues a root-observer re-entry after the snapshot that triggered it', async () => {
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    const firstNote = note(noteAId, workspaceA, 'first projection');
    const firstMutation = mutation(noteAId, 'op-first-projection', firstNote.bodyMd);
    const secondNote = note(noteAId, workspaceA, 'observer projection');
    const secondMutation = mutation(noteAId, 'op-observer-projection', secondNote.bodyMd);
    let observerDurable: Promise<void> | null = null;

    const dispose = store$.onChange(({ value }) => {
      if (observerDurable || value.notes[noteAId]?.bodyMd !== firstNote.bodyMd) return;
      observerDurable = applyReplicaForLease(lease, (current) => ({
        next: {
          ...current,
          notes: { ...current.notes, [noteAId]: secondNote },
          outbox: [secondMutation],
        },
        result: undefined,
      })).durable;
    });

    const first = applyReplicaForLease(lease, (current) => ({
      next: {
        ...current,
        notes: { ...current.notes, [noteAId]: firstNote },
        outbox: [firstMutation],
      },
      result: undefined,
    }));
    dispose();
    expect(observerDurable).not.toBeNull();
    await Promise.all([first.durable, observerDurable!]);

    const persisted = JSON.parse(
      memory.values.get(stateStorageKeys.replica(ownerKeyFor(sessionA)))!,
    ) as { notes: Record<string, Note>; outbox: SyncMutation[] };
    expect(persisted.notes[noteAId]?.bodyMd).toBe(secondNote.bodyMd);
    expect(persisted.outbox).toEqual([secondMutation]);
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe(secondNote.bodyMd);
    expect(store$.outbox.get()).toEqual([secondMutation]);
  });

  it('serializes hydration behind an in-flight account adoption', async () => {
    await adoptSession(sessionA);
    const gate = deferred();
    memory.block = { key: stateStorageKeys.session, promise: gate.promise };
    const adopting = adoptSession(sessionB);
    await vi.waitFor(() => expect(memory.block).toBeNull());

    const firstHydration = loadState();
    const secondHydration = loadState();
    expect(secondHydration).toBe(firstHydration);
    gate.resolve();
    await Promise.all([adopting, firstHydration]);

    expect(store$.session.get()).toEqual(sessionB);
    expect(memory.values.get(stateStorageKeys.session)).toBe(JSON.stringify(sessionB));
  });
});
