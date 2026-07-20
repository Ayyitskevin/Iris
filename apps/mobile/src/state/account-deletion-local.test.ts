/**
 * Local erase fence after confirmed server account deletion.
 * Drives the shipped `eraseLocalOwnerAfterConfirmedAccountDeletion` entry point with the
 * real store + SerializedKv repository (production default) behind a memory KV.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, SyncMutation } from '@iris/shared';

const memory = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failRemoveKey: null as string | null,
}));

vi.mock('./storage', () => ({
  storage: {
    get: async (key: string) => memory.values.get(key) ?? null,
    set: async (key: string, value: string) => {
      memory.values.set(key, value);
    },
    remove: async (key: string) => {
      if (memory.failRemoveKey === key) throw new Error('injected remove failure');
      memory.values.delete(key);
    },
  },
}));

import {
  adoptSession,
  eraseLocalOwnerAfterConfirmedAccountDeletion,
  loadState,
  ownerKeyFor,
  saveState,
  stateStorageKeys,
  store$,
  StatePersistenceError,
  type Session,
} from './store';
import { replicaRecoveryJournalOwnerKey } from './replica-recovery-journal';

const workspaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const noteAId = '33333333-3333-4333-8333-333333333333';

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

function mutation(noteId: string, opId: string, bodyMd: string): SyncMutation {
  return {
    opId,
    type: 'upsert',
    note: { id: noteId, title: bodyMd, bodyMd, folder: null, tags: [] },
    baseVersion: 0,
  };
}

describe('eraseLocalOwnerAfterConfirmedAccountDeletion', () => {
  beforeEach(async () => {
    memory.values.clear();
    memory.failRemoveKey = null;
    store$.set({
      session: null,
      activeOwnerKey: null,
      notes: {},
      syncCursor: '',
      deviceId: '',
      outbox: [],
      pendingPush: null,
      syncIssue: null,
      conflicts: {},
      status: 'idle',
      syncGated: false,
    });
    await loadState();
  });

  it('refuses erase without confirmed server deletion identity match', async () => {
    await adoptSession(sessionA);
    const ownerKey = ownerKeyFor(sessionA);

    await expect(
      eraseLocalOwnerAfterConfirmedAccountDeletion({
        // @ts-expect-error — prove runtime fail-closed if a caller forges confirmation
        serverDeleted: false,
        ownerKey,
        userId: sessionA.userId,
        workspaceId: sessionA.workspaceId,
      }),
    ).rejects.toBeInstanceOf(StatePersistenceError);

    await expect(
      eraseLocalOwnerAfterConfirmedAccountDeletion({
        serverDeleted: true,
        ownerKey: 'forged.owner',
        userId: sessionA.userId,
        workspaceId: sessionA.workspaceId,
      }),
    ).rejects.toBeInstanceOf(StatePersistenceError);

    expect(store$.session.get()?.token).toBe(sessionA.token);
    expect(memory.values.get(stateStorageKeys.replica(ownerKey))).toBeTruthy();
  });

  it('erases primary + recovery roots and credentials after confirmed deletion', async () => {
    await adoptSession(sessionA);
    const ownerKey = ownerKeyFor(sessionA);
    const privateBody = 'super-secret-note-body';
    const privateNote = note(noteAId, workspaceA, privateBody);

    store$.notes.set({ [privateNote.id]: privateNote });
    store$.outbox.set([mutation(noteAId, 'op-pending-delete', privateBody)]);
    store$.pendingPush.set(store$.outbox.get());
    await saveState();

    const replicaKey = stateStorageKeys.replica(ownerKey);
    expect(memory.values.get(replicaKey)).toContain(privateBody);

    // Stage a recovery-journal-shaped root under the journal owner key (same KV adapter).
    const journalOwner = replicaRecoveryJournalOwnerKey(ownerKey);
    const journalKey = stateStorageKeys.replica(journalOwner);
    memory.values.set(
      journalKey,
      JSON.stringify({
        version: 2,
        ownerKey: journalOwner,
        userId: sessionA.userId,
        workspaceId: sessionA.workspaceId,
        notes: { [privateNote.id]: privateNote },
        syncCursor: '',
        deviceId: 'device-a',
        outbox: [],
        pendingPush: null,
        syncIssue: null,
        conflicts: {},
      }),
    );

    const result = await eraseLocalOwnerAfterConfirmedAccountDeletion({
      serverDeleted: true,
      ownerKey,
      userId: sessionA.userId,
      workspaceId: sessionA.workspaceId,
    });

    expect(result).toEqual({ erased: true, ownerKey, hadLocalData: true });
    expect(store$.session.get()).toBeNull();
    expect(store$.notes.get()).toEqual({});
    expect(store$.outbox.get()).toEqual([]);
    expect(store$.pendingPush.get()).toBeNull();
    expect(store$.status.get()).toBe('auth-required');
    expect(store$.activeOwnerKey.get()).toBeNull();

    expect(memory.values.get(replicaKey)).toBeUndefined();
    expect(memory.values.get(journalKey)).toBeUndefined();

    const sessionRaw = memory.values.get(stateStorageKeys.session)!;
    expect(sessionRaw).not.toContain(sessionA.token);
    expect(sessionRaw).not.toContain(privateBody);
    expect(JSON.parse(sessionRaw)).toMatchObject({
      state: 'signed-out',
      reason: 'account-deleted',
      ownerKey,
    });

    for (const value of memory.values.values()) {
      expect(value).not.toContain(privateBody);
      expect(value).not.toContain(sessionA.token);
    }
  });

  it('is idempotent when local roots are already absent', async () => {
    const ownerKey = ownerKeyFor(sessionA);
    memory.values.set(
      stateStorageKeys.session,
      JSON.stringify({
        version: 2,
        state: 'signed-out',
        reason: 'account-deleted',
        ownerKey,
        completedAt: '2026-07-15T12:00:00.000Z',
      }),
    );

    const result = await eraseLocalOwnerAfterConfirmedAccountDeletion({
      serverDeleted: true,
      ownerKey,
      userId: sessionA.userId,
      workspaceId: sessionA.workspaceId,
    });
    expect(result.erased).toBe(true);
    expect(result.hadLocalData).toBe(false);
    expect(store$.status.get()).toBe('auth-required');
  });

  it('fails closed when durable remove cannot be verified', async () => {
    await adoptSession(sessionA);
    const ownerKey = ownerKeyFor(sessionA);
    memory.failRemoveKey = stateStorageKeys.replica(ownerKey);

    await expect(
      eraseLocalOwnerAfterConfirmedAccountDeletion({
        serverDeleted: true,
        ownerKey,
        userId: sessionA.userId,
        workspaceId: sessionA.workspaceId,
      }),
    ).rejects.toBeInstanceOf(StatePersistenceError);

    expect(store$.status.get()).toBe('error');
    expect(store$.session.get()).toBeNull();
  });

  it('refuses to erase while a different owner is active', async () => {
    await adoptSession(sessionB);
    const ownerA = ownerKeyFor(sessionA);

    await expect(
      eraseLocalOwnerAfterConfirmedAccountDeletion({
        serverDeleted: true,
        ownerKey: ownerA,
        userId: sessionA.userId,
        workspaceId: sessionA.workspaceId,
      }),
    ).rejects.toBeInstanceOf(StatePersistenceError);

    expect(store$.session.get()?.userId).toBe(sessionB.userId);
  });
});
