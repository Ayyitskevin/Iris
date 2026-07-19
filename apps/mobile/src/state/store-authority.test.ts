import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, SyncMutation } from '@iris/shared';
import type {
  OwnerAuthorityHandle,
  OwnerAuthorityHooks,
  OwnerAuthorityRole,
  OwnerAuthoritySnapshot,
} from './owner-replica-authority';

const local = vi.hoisted(() => ({ values: new Map<string, string>() }));
const replica = vi.hoisted(() => ({
  durable: new Map<string, string>(),
  reads: [] as string[],
  commits: [] as string[],
  prepares: [] as string[],
  verifies: [] as string[],
  prepareError: null as Error | null,
  verifyError: null as Error | null,
  commitGate: null as Promise<void> | null,
}));
const authority = vi.hoisted(() => ({
  nextRoles: [] as Array<'leader' | 'follower'>,
  handles: [] as Array<{
    ownerKey: string;
    closed: boolean;
    failPublish: boolean;
    published: unknown[];
    snapshot: OwnerAuthoritySnapshot;
    hooks: OwnerAuthorityHooks;
    becomeLeader(): Promise<void>;
    refresh(): void;
  }>,
}));

vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

vi.mock('./storage', () => ({
  storage: {
    get: async (key: string) => local.values.get(key) ?? null,
    set: async (key: string, value: string) => {
      local.values.set(key, value);
    },
    remove: async (key: string) => {
      local.values.delete(key);
    },
  },
}));

vi.mock('./select-owner-replica-repository', () => {
  const repository = {
    async read(ownerKey: string): Promise<string | null> {
      replica.reads.push(ownerKey);
      return replica.durable.get(ownerKey) ?? null;
    },
    async commit(ownerKey: string, raw: string): Promise<void> {
      replica.commits.push(ownerKey);
      if (replica.commitGate) await replica.commitGate;
      replica.durable.set(ownerKey, raw);
    },
  };
  return {
    ownerReplicaRepository: repository,
    ownerReplicaRuntime: {
      repository,
      recoveryRepository: repository,
      mode: 'transactional-web',
      readFollower: (ownerKey: string) => repository.read(ownerKey),
      prepareOwner: async (ownerKey: string) => {
        replica.prepares.push(ownerKey);
        if (replica.prepareError) throw replica.prepareError;
      },
      verifyBeforeNetwork: async (ownerKey: string) => {
        replica.verifies.push(ownerKey);
        if (replica.verifyError) throw replica.verifyError;
      },
      authority: {
        async start(ownerKey: string, hooks: OwnerAuthorityHooks): Promise<OwnerAuthorityHandle> {
          let epoch = 0;
          const setRole = (role: OwnerAuthorityRole): OwnerAuthoritySnapshot => {
            const snapshot = Object.freeze({ ownerKey, epoch: ++epoch, role });
            control.snapshot = snapshot;
            hooks.onRole(snapshot);
            return snapshot;
          };
          const control = {
            ownerKey,
            closed: false,
            failPublish: false,
            published: [] as unknown[],
            snapshot: Object.freeze({
              ownerKey,
              epoch,
              role: 'acquiring' as OwnerAuthorityRole,
            }),
            hooks,
            async becomeLeader() {
              const acquiring = setRole('acquiring');
              try {
                await hooks.prepareLeader(acquiring);
                if (!control.closed) setRole('leader');
              } catch {
                if (!control.closed) setRole('unavailable');
              }
            },
            refresh() {
              hooks.onRefresh(control.snapshot);
            },
          };
          authority.handles.push(control);
          setRole('acquiring');
          const initialRole = authority.nextRoles.shift() ?? 'leader';
          if (initialRole === 'leader') {
            try {
              await hooks.prepareLeader(control.snapshot);
              setRole('leader');
            } catch {
              setRole('unavailable');
            }
          } else {
            setRole('follower');
          }
          return {
            snapshot: () => control.snapshot,
            publishRefresh: () => {
              if (control.snapshot.role !== 'leader') throw new Error('not leader');
              if (control.failPublish) {
                setRole('unavailable');
                throw new Error('channel failed');
              }
              control.published.push({ version: 1, type: 'replica-changed' });
            },
            close: async () => {
              control.closed = true;
            },
          };
        },
      },
    },
  };
});

import { apiForLease, authenticatedRequest } from '../api';
import { createNoteLocal } from '../sync/manager';
import {
  adoptSession,
  loadState,
  openSessionLease,
  ownerKeyFor,
  replicaAuthority$,
  saveState,
  StaleSessionError,
  stateStorageKeys,
  store$,
  updateReplicaForLease,
  type ReplicaState,
  type Session,
} from './store';

const sessionA: Session = {
  token: 'token-A-private',
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'a@example.com',
  displayName: 'A',
};
const sessionB: Session = {
  token: 'token-B-private',
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'b@example.com',
  displayName: 'B',
};

function note(id: string, workspaceId: string, title: string): Note {
  return {
    id,
    workspaceId,
    title,
    bodyMd: title,
    folder: null,
    tags: [],
    version: 0,
    createdAt: '2026-07-19T12:00:00.000Z',
    updatedAt: '2026-07-19T12:00:00.000Z',
    deletedAt: null,
  };
}

function operation(noteValue: Note, opId: string): SyncMutation {
  return {
    opId,
    type: 'upsert',
    note: {
      id: noteValue.id,
      title: noteValue.title,
      bodyMd: noteValue.bodyMd,
      folder: null,
      tags: [],
    },
    baseVersion: 0,
  };
}

function serialized(session: Session, notes: Note[], outbox: SyncMutation[] = []): string {
  const ownerKey = ownerKeyFor(session);
  return JSON.stringify({
    version: 2,
    ownerKey,
    userId: session.userId,
    workspaceId: session.workspaceId,
    notes: Object.fromEntries(notes.map((value) => [value.id, value])),
    syncCursor: '',
    deviceId: 'device-' + session.userId,
    outbox,
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
  });
}

beforeEach(async () => {
  local.values.clear();
  replica.durable.clear();
  replica.reads = [];
  replica.commits = [];
  replica.prepares = [];
  replica.verifies = [];
  replica.prepareError = null;
  replica.verifyError = null;
  replica.commitGate = null;
  authority.nextRoles = [];
  authority.handles = [];
  await loadState();
});

describe('owner store web authority', () => {
  it('shows attributable v1 state when a leader has persisted the same-owner session first', async () => {
    const draft = note(
      '33333333-3333-4333-8333-333333333333',
      sessionA.workspaceId,
      'legacy draft',
    );
    local.values.set(stateStorageKeys.session, JSON.stringify(sessionA));
    local.values.set(
      stateStorageKeys.legacy,
      JSON.stringify({
        session: sessionA,
        notes: { [draft.id]: draft },
        outbox: [operation(draft, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')],
      }),
    );
    authority.nextRoles.push('follower');

    await loadState();

    expect(replicaAuthority$.get()).toBe('follower');
    expect(store$.status.get()).toBe('idle');
    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.notes.get()[draft.id]).toEqual(draft);
    expect(replica.commits).toEqual([]);
    expect(local.values.has(stateStorageKeys.legacy)).toBe(true);
    expect(local.values.has(stateStorageKeys.migration)).toBe(false);
  });

  it('keeps a follower read-only, refreshes from durable bytes, then rereads before takeover', async () => {
    const first = note('33333333-3333-4333-8333-333333333333', sessionA.workspaceId, 'first');
    replica.durable.set(ownerKeyFor(sessionA), serialized(sessionA, [first]));
    authority.nextRoles.push('follower');
    await adoptSession(sessionA);
    const handle = authority.handles.at(-1)!;

    expect(replicaAuthority$.get()).toBe('follower');
    expect(openSessionLease()).toBeNull();
    expect(store$.notes.get()[first.id]?.title).toBe('first');
    const commitsBefore = [...replica.commits];
    expect(await saveState()).toBe(true);
    expect(replica.commits).toEqual(commitsBefore);

    const projectionBeforeReducerAttempt = store$.notes.get();
    expect(() => createNoteLocal({ title: 'must not appear', bodyMd: 'must not commit' })).toThrow(
      'Authentication required',
    );
    expect(store$.notes.get()).toEqual(projectionBeforeReducerAttempt);
    expect(replica.commits).toEqual(commitsBefore);

    let callbackRan = false;
    await expect(
      authenticatedRequest(async () => {
        callbackRan = true;
        return true;
      }),
    ).rejects.toThrow('Authentication required');
    expect(callbackRan).toBe(false);

    const pending = operation(first, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    const refreshed = { ...first, title: 'leader edit', bodyMd: 'leader edit' };
    replica.durable.set(ownerKeyFor(sessionA), serialized(sessionA, [refreshed], [pending]));
    handle.refresh();
    await vi.waitFor(() => expect(store$.notes.get()[first.id]?.title).toBe('leader edit'));
    expect(store$.outbox.get()).toEqual([pending]);
    expect(replica.commits).toEqual(commitsBefore);

    const rereadOnly = { ...refreshed, title: 'takeover reread', bodyMd: 'takeover reread' };
    replica.durable.set(ownerKeyFor(sessionA), serialized(sessionA, [rereadOnly], [pending]));
    const readsBeforeTakeover = replica.reads.filter((key) => key === ownerKeyFor(sessionA)).length;
    const takingOver = handle.becomeLeader();
    expect(replicaAuthority$.get()).toBe('acquiring');
    expect(openSessionLease()).toBeNull();
    await takingOver;
    expect(replicaAuthority$.get()).toBe('leader');
    expect(openSessionLease()).not.toBeNull();
    expect(store$.notes.get()[first.id]?.title).toBe('takeover reread');
    expect(store$.outbox.get()).toEqual([pending]);
    expect(replica.reads.filter((key) => key === ownerKeyFor(sessionA)).length).toBeGreaterThan(
      readsBeforeTakeover,
    );
    expect(replica.prepares.filter((key) => key === ownerKeyFor(sessionA))).toHaveLength(1);
  });

  it('fences the owner and dispatches no request when last-moment authority verification fails', async () => {
    replica.durable.set(ownerKeyFor(sessionA), serialized(sessionA, []));
    authority.nextRoles.push('leader');
    await adoptSession(sessionA);
    const lease = openSessionLease()!;
    const verificationError = new Error('injected legacy divergence');
    replica.verifyError = verificationError;
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(apiForLease(lease).billingStatus()).rejects.toBe(verificationError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(replica.verifies).toEqual([ownerKeyFor(sessionA)]);
    expect(lease.signal.aborted).toBe(true);
    expect(openSessionLease()).toBeNull();
    expect(store$.status.get()).toBe('recovery-required');
    fetchMock.mockRestore();
  });

  it('retains the recovery fence when leader preparation fails before initial publication', async () => {
    const root = serialized(sessionA, []);
    replica.durable.set(ownerKeyFor(sessionA), root);
    replica.prepareError = new Error('injected unreadable divergence journal');
    authority.nextRoles.push('leader');

    await adoptSession(sessionA);

    expect(replicaAuthority$.get()).toBe('unavailable');
    expect(replica.prepares).toEqual([ownerKeyFor(sessionA)]);
    expect(replica.durable.get(ownerKeyFor(sessionA))).toBe(root);
    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.status.get()).toBe('recovery-required');
    expect(openSessionLease()).toBeNull();
  });

  it('publishes only after a verified commit and ignores late A refreshes after switching to B', async () => {
    const a = note('33333333-3333-4333-8333-333333333333', sessionA.workspaceId, 'A');
    const b = note('44444444-4444-4444-8444-444444444444', sessionB.workspaceId, 'B');
    replica.durable.set(ownerKeyFor(sessionA), serialized(sessionA, [a]));
    replica.durable.set(ownerKeyFor(sessionB), serialized(sessionB, [b]));
    authority.nextRoles.push('leader');
    await adoptSession(sessionA);
    const handleA = authority.handles.at(-1)!;
    const publishedBefore = handleA.published.length;
    let releaseCommit!: () => void;
    replica.commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const saving = updateReplicaForLease(openSessionLease()!, (current: ReplicaState) => current);
    await vi.waitFor(() => expect(replica.commits).toContain(ownerKeyFor(sessionA)));
    expect(handleA.published).toHaveLength(publishedBefore);
    releaseCommit();
    await saving;
    expect(handleA.published).toHaveLength(publishedBefore + 1);
    replica.commitGate = null;

    authority.nextRoles.push('leader');
    await adoptSession(sessionB);
    expect(handleA.closed).toBe(true);
    expect(store$.activeOwnerKey.get()).toBe(ownerKeyFor(sessionB));
    replica.durable.set(ownerKeyFor(sessionA), serialized(sessionA, [{ ...a, title: 'late A' }]));
    handleA.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store$.activeOwnerKey.get()).toBe(ownerKeyFor(sessionB));
    expect(store$.notes.get()).toEqual({ [b.id]: b });
  });

  it('keeps a verified commit durable when refresh publication fails closed', async () => {
    const first = note('33333333-3333-4333-8333-333333333333', sessionA.workspaceId, 'first');
    replica.durable.set(ownerKeyFor(sessionA), serialized(sessionA, [first]));
    authority.nextRoles.push('leader');
    await adoptSession(sessionA);
    const handle = authority.handles.at(-1)!;
    handle.failPublish = true;

    const changed = { ...first, title: 'durable despite channel failure' };
    await expect(
      updateReplicaForLease(openSessionLease()!, (current) => ({
        ...current,
        notes: { ...current.notes, [changed.id]: changed },
      })),
    ).rejects.toBeInstanceOf(StaleSessionError);

    expect(replicaAuthority$.get()).toBe('unavailable');
    const durable = JSON.parse(replica.durable.get(ownerKeyFor(sessionA))!) as {
      notes: Record<string, Note>;
    };
    expect(durable.notes[first.id]?.title).toBe('durable despite channel failure');
  });
});
