import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '@iris/shared';

/**
 * Fence-awareness of the owner store (plan A3, step 2).
 *
 * Production still uses the non-fencing `SerializedKvReplicaRepository`, so these paths are
 * dormant until the A3 step-3 flip. Here `ownerReplicaRepository` is replaced with a
 * controllable repository that throws `ReplicaRepositoryStaleWriterError` on a commit and
 * clears the fence on the next read — the exact contract of the transactional stores
 * (ADR-017). The store must then read + rehydrate authoritative bytes, never roll back to the
 * losing optimistic root, and must not get permanently stuck.
 */
const memory = vi.hoisted(() => ({ values: new Map<string, string>() }));

const repo = vi.hoisted(() => ({
  durable: new Map<string, string>(),
  /** Owners currently fenced. Set by a losing commit, cleared only by a read (ADR-017). */
  fenced: new Set<string>(),
  /** Owners whose next commit loses a concurrent race (a winner advanced the durable copy). */
  raceNextCommit: new Set<string>(),
  /** Authoritative bytes the concurrent winner leaves behind when our commit loses. */
  winner: new Map<string, string>(),
  /** Force one generic (non-fence) commit failure to prove that path is unchanged. */
  failCommitKey: null as string | null,
  /**
   * Builds the real `ReplicaRepositoryStaleWriterError`. Populated at module top level after
   * the imports resolve — the mock factory must not import the transactional module itself,
   * because that module imports the very `./replica-repository` being mocked (a load deadlock).
   */
  makeStaleError: null as ((ownerKey: string) => Error) | null,
  reads: [] as string[],
  commits: [] as string[],
}));

vi.mock('./storage', () => ({
  storage: {
    get: async (key: string) => memory.values.get(key) ?? null,
    set: async (key: string, value: string) => {
      memory.values.set(key, value);
    },
    remove: async (key: string) => {
      memory.values.delete(key);
    },
  },
}));

vi.mock('./replica-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./replica-repository')>();
  return {
    ...actual,
    ownerReplicaRepository: {
      async read(ownerKey: string): Promise<string | null> {
        repo.reads.push(ownerKey);
        // A read is what clears a stale-writer fence and returns the authoritative bytes.
        repo.fenced.delete(ownerKey);
        return repo.durable.get(ownerKey) ?? null;
      },
      async commit(ownerKey: string, raw: string): Promise<void> {
        repo.commits.push(ownerKey);
        if (repo.failCommitKey === ownerKey) {
          repo.failCommitKey = null;
          throw new Error('injected non-fence commit failure');
        }
        if (repo.raceNextCommit.has(ownerKey)) {
          // A concurrent winner advanced the durable replica between our read and this
          // commit, so our compare-and-swap loses. The winner's bytes stay durable and this
          // instance is fenced until it reads them.
          repo.raceNextCommit.delete(ownerKey);
          const winner = repo.winner.get(ownerKey);
          if (winner !== undefined) repo.durable.set(ownerKey, winner);
          repo.fenced.add(ownerKey);
          throw repo.makeStaleError!(ownerKey);
        }
        if (repo.fenced.has(ownerKey)) throw repo.makeStaleError!(ownerKey);
        repo.durable.set(ownerKey, raw);
      },
    },
  };
});

import { ReplicaRepositoryStaleWriterError } from './transactional-replica-repository';
import {
  adoptSession,
  applyReplicaForLease,
  loadState,
  openSessionLease,
  ownerKeyFor,
  saveState,
  StatePersistenceError,
  store$,
  updateReplicaForLease,
  type Session,
  type SessionLease,
} from './store';

// The mock factory throws this exact class so store.ts's `instanceof` check matches; it is
// wired here (after imports resolve) to avoid importing the transactional module inside the
// factory, which would deadlock on the mocked `./replica-repository`.
repo.makeStaleError = (ownerKey: string) => new ReplicaRepositoryStaleWriterError(ownerKey);

const workspaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userA = '11111111-1111-4111-8111-111111111111';
const noteAId = '33333333-3333-4333-8333-333333333333';
const noteBId = '44444444-4444-4444-8444-444444444444';
const noteCId = '55555555-5555-4555-8555-555555555555';

const sessionA: Session = {
  token: 'token-A-secret',
  userId: userA,
  workspaceId: workspaceA,
  email: 'a@example.com',
  displayName: 'A',
};

function note(id: string, bodyMd: string): Note {
  return {
    id,
    workspaceId: workspaceA,
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

/** Serialize an authoritative replica for `sessionA` exactly as the store persists one. */
function winnerBytes(notes: Record<string, Note>, deviceId: string): string {
  return JSON.stringify({
    version: 2,
    ownerKey: ownerKeyFor(sessionA),
    userId: sessionA.userId,
    workspaceId: sessionA.workspaceId,
    notes,
    syncCursor: '',
    deviceId,
    outbox: [],
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
  });
}

async function signIn(): Promise<SessionLease> {
  await adoptSession(sessionA);
  const lease = openSessionLease();
  if (!lease) throw new Error('expected a session lease after sign-in');
  return lease;
}

beforeEach(async () => {
  memory.values.clear();
  repo.durable.clear();
  repo.fenced.clear();
  repo.raceNextCommit.clear();
  repo.winner.clear();
  repo.failCommitKey = null;
  repo.reads = [];
  repo.commits = [];
  await loadState();
});

describe('owner store fence-awareness', () => {
  it('saveState adopts authoritative bytes on a stale-writer fence rather than erroring', async () => {
    const lease = await signIn();
    await updateReplicaForLease(lease, (current) => ({ ...current, notes: { [noteAId]: note(noteAId, 'loser') } }));

    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(ownerKey, winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()));
    repo.raceNextCommit.add(ownerKey);

    expect(await saveState()).toBe(true);
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
    expect(store$.notes.get()[noteBId]?.bodyMd).toBe('winner');
    expect(store$.status.get()).not.toBe('error');
  });

  it('clears the fence so the next edit persists durably (never permanently stuck)', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    await updateReplicaForLease(lease, (current) => ({ ...current, notes: { [noteAId]: note(noteAId, 'loser') } }));

    repo.winner.set(ownerKey, winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()));
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(true);

    // The fence was cleared by the adopting read; a fresh edit must reach durable storage.
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { ...current.notes, [noteCId]: note(noteCId, 'after') },
    }));
    const persisted = JSON.parse(repo.durable.get(ownerKey)!) as { notes: Record<string, Note> };
    expect(Object.keys(persisted.notes).sort()).toEqual([noteBId, noteCId].sort());
  });

  it('resolves (not rejects) the hot-path durable promise on a fence and adopts the winner', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(ownerKey, winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()));
    repo.raceNextCommit.add(ownerKey);

    const applied = applyReplicaForLease(lease, (current) => ({
      next: { ...current, notes: { [noteAId]: note(noteAId, 'loser') } },
      result: 'created',
    }));

    await expect(applied.durable).resolves.toBeUndefined();
    expect(applied.result).toBe('created');
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
  });

  it('does not roll a committed change back on a fence; it adopts authoritative bytes', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(ownerKey, winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()));
    repo.raceNextCommit.add(ownerKey);

    await expect(
      updateReplicaForLease(lease, (current) => ({
        ...current,
        notes: { ...current.notes, [noteAId]: note(noteAId, 'loser') },
      })),
    ).resolves.toBeUndefined();

    // Neither the losing edit nor the pre-edit projection: the authoritative winner.
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
  });

  it('adopts the concurrent winner when creating the fresh empty replica loses the race', async () => {
    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(ownerKey, winnerBytes({ [noteBId]: note(noteBId, 'winner') }, 'device-winner'));
    repo.raceNextCommit.add(ownerKey);

    await adoptSession(sessionA);

    expect(store$.session.get()).toEqual(sessionA);
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
    expect(store$.deviceId.get()).toBe('device-winner');
  });

  it('still rolls back and reports a genuine (non-fence) persistence failure', async () => {
    const lease = await signIn();
    repo.failCommitKey = ownerKeyFor(sessionA);

    await expect(
      updateReplicaForLease(lease, (current) => ({
        ...current,
        notes: { ...current.notes, [noteAId]: note(noteAId, 'loser') },
      })),
    ).rejects.toBeInstanceOf(StatePersistenceError);

    // The optimistic edit was rolled back, exactly as before fence-awareness existed.
    expect(store$.notes.get()[noteAId]).toBeUndefined();
  });
});
