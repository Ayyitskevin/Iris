import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, SyncMutation } from '@iris/shared';
import type { OwnerAuthorityHooks } from './owner-replica-authority';

/**
 * Fence-awareness of the owner store (plan A3, step 2).
 *
 * Production still uses the non-fencing `SerializedKvReplicaRepository`, so these paths are
 * dormant until the A3 step-3 flip. Here `ownerReplicaRepository` is replaced with a
 * controllable repository that throws `ReplicaRepositoryStaleWriterError` on a commit and
 * clears the fence on the next read — the exact contract of the transactional stores
 * (ADR-017). The store must read + validate the winner, reject the losing commit, and retain
 * an application-level fence if the returned bytes cannot be understood.
 */
const memory = vi.hoisted(() => ({ values: new Map<string, string>() }));

const repo = vi.hoisted(() => ({
  durable: new Map<string, string>(),
  /** Owners currently fenced. Set by a losing commit, cleared only by a read (ADR-017). */
  fenced: new Set<string>(),
  /** Owners whose next commit loses a concurrent race (a winner advanced the durable copy). */
  raceNextCommit: new Set<string>(),
  /** Authoritative bytes the concurrent winner leaves behind when our commit loses. */
  winner: new Map<string, string | null>(),
  /** Delay one authoritative read so tests can exercise the application recovery interval. */
  readGates: new Map<
    string,
    {
      started: Promise<void>;
      markStarted: () => void;
      unblocked: Promise<void>;
      unblock: () => void;
    }
  >(),
  readGateReleases: new Set<() => void>(),
  /** Simulate a transactional adapter rejecting an invalid record before returning bytes. */
  failReadKey: null as string | null,
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

vi.mock('./select-owner-replica-repository', () => {
  const repository = {
    async read(ownerKey: string): Promise<string | null> {
      repo.reads.push(ownerKey);
      if (repo.failReadKey === ownerKey) {
        throw new Error('injected invalid transactional record');
      }
      const observed = repo.durable.get(ownerKey) ?? null;
      const gate = repo.readGates.get(ownerKey);
      if (gate) {
        repo.readGates.delete(ownerKey);
        gate.markStarted();
        await gate.unblocked;
      }
      // A read is what clears a stale-writer fence and returns the authoritative bytes.
      repo.fenced.delete(ownerKey);
      return observed;
    },
    async commit(ownerKey: string, raw: string): Promise<void> {
      repo.commits.push(ownerKey);
      if (repo.failCommitKey === ownerKey) {
        repo.failCommitKey = null;
        throw new Error('injected non-fence commit failure');
      }
      if (repo.raceNextCommit.has(ownerKey)) {
        // A concurrent winner advanced the durable replica between our read and this commit,
        // so our compare-and-swap loses. The winner's bytes stay durable and this instance is
        // fenced until it reads them.
        repo.raceNextCommit.delete(ownerKey);
        const winner = repo.winner.get(ownerKey);
        if (winner === null) repo.durable.delete(ownerKey);
        else if (winner !== undefined) repo.durable.set(ownerKey, winner);
        repo.fenced.add(ownerKey);
        throw repo.makeStaleError!(ownerKey);
      }
      if (repo.fenced.has(ownerKey)) throw repo.makeStaleError!(ownerKey);
      repo.durable.set(ownerKey, raw);
    },
  };
  return {
    ownerReplicaRepository: repository,
    ownerReplicaRuntime: {
      repository,
      mode: 'transactional-native',
      readFollower: (ownerKey: string) => repository.read(ownerKey),
      authority: {
        async start(ownerKey: string, hooks: OwnerAuthorityHooks) {
          const acquiring = { ownerKey, epoch: 1, role: 'acquiring' as const };
          hooks.onRole(acquiring);
          await hooks.prepareLeader(acquiring);
          const leader = { ownerKey, epoch: 2, role: 'leader' as const };
          hooks.onRole(leader);
          return {
            snapshot: () => leader,
            publishRefresh: () => undefined,
            close: async () => undefined,
          };
        },
      },
    },
  };
});

import {
  parseReplicaRecoveryEnvelope,
  replicaRecoveryJournalOwnerKey,
} from './replica-recovery-journal';
import { parseReplicaRecoveryExport } from '../recovery/export';
import { ReplicaRepositoryStaleWriterError } from './transactional-replica-repository';
import {
  adoptSession,
  applyReplicaForLease,
  createReplicaRecoveryExportForLease,
  expireSessionIfCurrent,
  isCurrentReplicaRecoveryExportArtifact,
  loadState,
  openRecoveryInspectionLease,
  openSessionLease,
  ownerKeyFor,
  readReplicaRecoveryCatalogForLease,
  recoveryCatalogRevision$,
  ReplicaCommitSupersededError,
  saveState,
  signOutSession,
  stateStorageKeys,
  StaleRecoveryInspectionError,
  StaleSessionError,
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

const sessionB: Session = {
  token: 'token-B-secret',
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: workspaceA,
  email: 'b@example.com',
  displayName: 'B',
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

function mutation(id: string, opId: string, bodyMd: string): SyncMutation {
  return {
    opId,
    type: 'upsert',
    note: { id, title: bodyMd, bodyMd, folder: null, tags: [] },
    baseVersion: 1,
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

function recoveryEnvelope(ownerKey: string) {
  const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
  const raw = repo.durable.get(recoveryKey);
  if (!raw) throw new Error('expected an owner recovery journal');
  return {
    key: recoveryKey,
    raw,
    envelope: parseReplicaRecoveryEnvelope(raw, ownerKey),
  };
}

function holdNextRead(ownerKey: string): { started: Promise<void>; unblock: () => void } {
  let markStarted!: () => void;
  let unblock!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const unblocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  repo.readGates.set(ownerKey, { started, markStarted, unblocked, unblock });
  const release = (): void => {
    repo.readGateReleases.delete(release);
    unblock();
  };
  repo.readGateReleases.add(release);
  return { started, unblock: release };
}

async function signIn(): Promise<SessionLease> {
  await adoptSession(sessionA);
  const lease = openSessionLease();
  if (!lease) throw new Error('expected a session lease after sign-in');
  return lease;
}

function recoveryInspectionLease() {
  const lease = openRecoveryInspectionLease();
  if (!lease) throw new Error('expected a recovery inspection lease');
  return lease;
}

async function expectUnreadableWinnerIsFenced(
  buildWinner: (deviceId: string) => string | null,
): Promise<void> {
  const lease = await signIn();
  const ownerKey = ownerKeyFor(sessionA);
  await updateReplicaForLease(lease, (current) => ({
    ...current,
    notes: { [noteAId]: note(noteAId, 'last readable root') },
  }));

  repo.winner.set(ownerKey, buildWinner(store$.deviceId.get()));
  repo.raceNextCommit.add(ownerKey);
  expect(await saveState()).toBe(false);
  expect(store$.status.get()).toBe('recovery-required');

  const durableAfterFence = repo.durable.get(ownerKey);
  const commitCountAfterFence = repo.commits.length;
  await expect(
    updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { ...current.notes, [noteCId]: note(noteCId, 'must not overwrite') },
    })),
  ).rejects.toBeInstanceOf(StaleSessionError);

  expect(repo.commits).toHaveLength(commitCountAfterFence);
  expect(repo.durable.get(ownerKey)).toBe(durableAfterFence);
}

beforeEach(async () => {
  memory.values.clear();
  repo.durable.clear();
  repo.fenced.clear();
  repo.raceNextCommit.clear();
  repo.winner.clear();
  repo.readGates.clear();
  repo.failReadKey = null;
  repo.failCommitKey = null;
  repo.reads = [];
  repo.commits = [];
  await loadState();
});

describe('owner store fence-awareness', () => {
  it('saveState adopts authoritative bytes but reports that its snapshot was superseded', async () => {
    const lease = await signIn();
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [noteAId]: note(noteAId, 'loser') },
    }));

    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);

    expect(await saveState()).toBe(false);
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
    expect(store$.notes.get()[noteBId]?.bodyMd).toBe('winner');
    expect(store$.status.get()).toBe('error');
  });

  it('journals the exact losing draft and outbox without credential state', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const localNote = note(noteAId, 'offline draft that lost the CAS');
    const localMutation = mutation(noteAId, 'op-offline-draft', localNote.bodyMd);
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);

    const losing = applyReplicaForLease(lease, (current) => ({
      next: {
        ...current,
        notes: { [localNote.id]: localNote },
        outbox: [localMutation],
      },
      result: undefined,
    }));

    await expect(losing.durable).rejects.toBeInstanceOf(ReplicaCommitSupersededError);

    const recovery = recoveryEnvelope(ownerKey);
    expect(recovery.raw).not.toContain(sessionA.token);
    expect(recovery.envelope.snapshots).toHaveLength(1);
    expect(recovery.envelope.snapshots[0]).toMatchObject({
      sequence: 1,
      reason: 'stale-writer',
    });
    const preserved = JSON.parse(recovery.envelope.snapshots[0]!.serializedReplica) as {
      notes: Record<string, Note>;
      outbox: SyncMutation[];
    };
    expect(preserved.notes).toEqual({ [localNote.id]: localNote });
    expect(preserved.outbox).toEqual([localMutation]);
  });

  it('surfaces and exports a preserved loser after a valid winner without rewriting either root', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    const loser = note(noteAId, 'preserved loser');
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [loser.id]: loser },
    }));
    const loserRaw = repo.durable.get(ownerKey)!;
    const winnerRaw = winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get());
    repo.winner.set(ownerKey, winnerRaw);
    repo.raceNextCommit.add(ownerKey);

    expect(await saveState()).toBe(false);
    expect(store$.status.get()).toBe('error');
    const journalRaw = repo.durable.get(recoveryKey)!;
    const commitsBeforeInspection = [...repo.commits];
    repo.reads = [];
    const inspection = recoveryInspectionLease();

    const catalog = await readReplicaRecoveryCatalogForLease(inspection);
    expect(catalog!.preservedCount).toBe(1);
    expect(catalog!.copies.map((copy) => copy.persistence)).toEqual([
      'journal-verified',
      'displayed-only',
    ]);
    expect(catalog!.copies[0]!.matchesDisplayedProjection).toBe(false);
    expect(catalog!.copies[1]!.matchesDisplayedProjection).toBe(true);

    const firstExport = await createReplicaRecoveryExportForLease(
      inspection,
      '2026-07-19T16:00:00.000Z',
    );
    const secondExport = await createReplicaRecoveryExportForLease(
      inspection,
      '2026-07-19T16:00:00.000Z',
    );
    const parsed = parseReplicaRecoveryExport(firstExport.serializedExport, ownerKey);
    expect(parsed.snapshots[0]!.serializedReplica).toBe(loserRaw);
    expect(parsed.displayed).toMatchObject({ kind: 'embedded' });
    expect(firstExport.serializedExport).toBe(secondExport.serializedExport);
    expect(firstExport.serializedExport).not.toContain(sessionA.token);
    expect(repo.commits).toEqual(commitsBeforeInspection);
    expect(repo.durable.get(ownerKey)).toBe(winnerRaw);
    expect(repo.durable.get(recoveryKey)).toBe(journalRaw);
    expect(new Set(repo.reads)).toEqual(new Set([recoveryKey]));
  });

  it('lists every distinct loser in capture sequence during read-only recovery', async () => {
    const firstLease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    await updateReplicaForLease(firstLease, (current) => ({
      ...current,
      notes: { [noteAId]: note(noteAId, 'first loser') },
    }));
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'first winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);
    expect(store$.status.get()).toBe('error');

    const secondLease = openSessionLease();
    if (!secondLease) throw new Error('expected a fresh lease after the first recovery');
    await updateReplicaForLease(secondLease, (current) => ({
      ...current,
      notes: { ...current.notes, [noteCId]: note(noteCId, 'second loser') },
    }));
    repo.winner.set(ownerKey, '{');
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);

    expect(store$.status.get()).toBe('recovery-required');
    expect(openSessionLease()).toBeNull();
    const catalog = await readReplicaRecoveryCatalogForLease(recoveryInspectionLease());
    expect(catalog!.copies.map((copy) => copy.sequence)).toEqual([1, 2]);
    expect(catalog!.copies.map((copy) => copy.liveNoteCount)).toEqual([1, 2]);
    expect(catalog!.copies.map((copy) => copy.matchesDisplayedProjection)).toEqual([false, true]);
  });

  it('shows memory-only candidates and refuses an incomplete export until append verification succeeds', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    const localNote = note(noteAId, 'pending recovery export');
    const localMutation = mutation(noteAId, 'op-pending-export', localNote.bodyMd);
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [localNote.id]: localNote },
      outbox: [localMutation],
    }));
    const loserRaw = repo.durable.get(ownerKey)!;
    const winnerRaw = winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get());
    repo.winner.set(ownerKey, winnerRaw);
    repo.raceNextCommit.add(ownerKey);
    repo.failCommitKey = recoveryKey;

    expect(await saveState()).toBe(false);
    expect(store$.status.get()).toBe('recovery-required');
    const inspection = recoveryInspectionLease();
    const pendingCatalog = await readReplicaRecoveryCatalogForLease(inspection);
    expect(pendingCatalog).toMatchObject({
      preservedCount: 1,
      journalVerifiedCount: 0,
      memoryOnlyCount: 1,
      hasUnverifiedCopies: true,
    });
    expect(pendingCatalog!.copies[0]).toMatchObject({
      persistence: 'memory-only',
      matchesDisplayedProjection: true,
    });

    repo.failCommitKey = recoveryKey;
    await expect(
      createReplicaRecoveryExportForLease(inspection, '2026-07-19T16:01:00.000Z'),
    ).rejects.toBeInstanceOf(StatePersistenceError);
    expect(repo.durable.has(recoveryKey)).toBe(false);
    expect(repo.durable.get(ownerKey)).toBe(winnerRaw);
    expect(store$.status.get()).toBe('recovery-required');

    const artifact = await createReplicaRecoveryExportForLease(
      inspection,
      '2026-07-19T16:01:01.000Z',
    );
    const parsed = parseReplicaRecoveryExport(artifact.serializedExport, ownerKey);
    expect(parsed.snapshots.map((snapshot) => snapshot.serializedReplica)).toEqual([loserRaw]);
    expect(artifact.catalog).toMatchObject({ memoryOnlyCount: 0, journalVerifiedCount: 1 });
    const commitsAfterVerifiedExport = [...repo.commits];
    await createReplicaRecoveryExportForLease(inspection, '2026-07-19T16:01:02.000Z');
    expect(repo.commits).toEqual(commitsAfterVerifiedExport);
    expect(repo.durable.get(ownerKey)).toBe(winnerRaw);
  });

  it('retries an inventory read that overlaps a pending copy becoming journal-verified', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    const localNote = note(noteAId, 'pending transition');
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [localNote.id]: localNote },
    }));
    const loserRaw = repo.durable.get(ownerKey)!;
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);
    repo.failCommitKey = recoveryKey;
    expect(await saveState()).toBe(false);

    const inspection = recoveryInspectionLease();
    const gate = holdNextRead(recoveryKey);
    const delayedCatalog = readReplicaRecoveryCatalogForLease(inspection);
    await gate.started;
    const artifact = await createReplicaRecoveryExportForLease(
      inspection,
      '2026-07-19T16:02:00.000Z',
    );
    gate.unblock();

    await expect(delayedCatalog).resolves.toMatchObject({
      inventoryComplete: true,
      preservedCount: 1,
      journalVerifiedCount: 1,
      memoryOnlyCount: 0,
    });
    expect(
      parseReplicaRecoveryExport(artifact.serializedExport, ownerKey).snapshots[0]!
        .serializedReplica,
    ).toBe(loserRaw);
  });

  it('still shows exact memory-only copies when durable journal inspection fails', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [noteAId]: note(noteAId, 'memory-only during read failure') },
    }));
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);
    repo.failCommitKey = recoveryKey;
    expect(await saveState()).toBe(false);
    repo.failReadKey = recoveryKey;

    const catalog = await readReplicaRecoveryCatalogForLease(recoveryInspectionLease());

    expect(catalog).toMatchObject({
      inventoryComplete: false,
      preservedCount: 1,
      journalVerifiedCount: 0,
      memoryOnlyCount: 1,
    });
    expect(catalog!.copies[0]).toMatchObject({
      persistence: 'memory-only',
      matchesDisplayedProjection: true,
    });
    repo.failReadKey = null;
    await createReplicaRecoveryExportForLease(
      recoveryInspectionLease(),
      '2026-07-19T16:03:00.000Z',
    );
  });

  it('rejects a delayed owner-A recovery read after switching to owner B', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [noteAId]: note(noteAId, 'owner A loser') },
    }));
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'owner A winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);
    const journalRaw = repo.durable.get(recoveryKey);
    const gate = holdNextRead(recoveryKey);
    const delayed = readReplicaRecoveryCatalogForLease(recoveryInspectionLease());

    await gate.started;
    await adoptSession(sessionB);
    gate.unblock();

    await expect(delayed).rejects.toBeInstanceOf(StaleSessionError);
    expect(store$.session.get()).toEqual(sessionB);
    expect(store$.activeOwnerKey.get()).toBe(ownerKeyFor(sessionB));
    expect(repo.durable.get(recoveryKey)).toBe(journalRaw);
  });

  it('rejects a same-owner catalog read when the displayed projection changes in flight', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [noteAId]: note(noteAId, 'loser') },
    }));
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);
    const inspection = recoveryInspectionLease();
    const gate = holdNextRead(recoveryKey);
    const delayed = readReplicaRecoveryCatalogForLease(inspection);

    await gate.started;
    const currentLease = openSessionLease();
    if (!currentLease) throw new Error('expected writable winner lease');
    await updateReplicaForLease(currentLease, (current) => ({
      ...current,
      notes: { ...current.notes, [noteCId]: note(noteCId, 'changed while reading') },
    }));
    gate.unblock();

    await expect(delayed).rejects.toBeInstanceOf(StaleRecoveryInspectionError);
  });

  it('invalidates a completed export artifact when the displayed projection changes', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [noteAId]: note(noteAId, 'loser') },
    }));
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);
    const inspection = recoveryInspectionLease();
    const artifact = await createReplicaRecoveryExportForLease(
      inspection,
      '2026-07-19T16:03:00.000Z',
    );
    expect(isCurrentReplicaRecoveryExportArtifact(inspection, artifact)).toBe(true);
    const revision = recoveryCatalogRevision$.get();

    const currentLease = openSessionLease();
    if (!currentLease) throw new Error('expected writable winner lease');
    await updateReplicaForLease(currentLease, (current) => ({
      ...current,
      notes: { ...current.notes, [noteCId]: note(noteCId, 'changed after export creation') },
    }));

    expect(recoveryCatalogRevision$.get()).toBeGreaterThan(revision);
    expect(isCurrentReplicaRecoveryExportArtifact(inspection, artifact)).toBe(false);
  });

  it('fails closed on a malformed journal without normalizing or deleting its bytes', async () => {
    await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    repo.durable.set(recoveryKey, '{');
    const commitsBefore = [...repo.commits];

    await expect(
      readReplicaRecoveryCatalogForLease(recoveryInspectionLease()),
    ).rejects.toBeInstanceOf(StatePersistenceError);

    expect(repo.durable.get(recoveryKey)).toBe('{');
    expect(repo.commits).toEqual(commitsBefore);
  });
  it('retains the exact loser when its first journal append fails', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    const localNote = note(noteAId, 'journal retry draft');
    const localMutation = mutation(noteAId, 'op-journal-retry', localNote.bodyMd);
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [localNote.id]: localNote },
      outbox: [localMutation],
    }));
    const loserRaw = repo.durable.get(ownerKey)!;
    const winnerRaw = winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get());
    repo.winner.set(ownerKey, winnerRaw);
    repo.raceNextCommit.add(ownerKey);
    repo.failCommitKey = recoveryKey;

    expect(await saveState()).toBe(false);

    expect(store$.status.get()).toBe('recovery-required');
    expect(store$.notes.get()).toEqual({ [localNote.id]: localNote });
    expect(store$.outbox.get()).toEqual([localMutation]);
    expect(repo.durable.get(ownerKey)).toBe(winnerRaw);
    expect(repo.durable.has(recoveryKey)).toBe(false);

    await signOutSession();

    expect(store$.session.get()).toBeNull();
    expect(repo.durable.get(ownerKey)).toBe(winnerRaw);
    expect(recoveryEnvelope(ownerKey).envelope.snapshots.at(-1)!.serializedReplica).toBe(loserRaw);
  });

  it('clears the fence so the next edit persists durably (never permanently stuck)', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [noteAId]: note(noteAId, 'loser') },
    }));

    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);

    // The fence was cleared by the adopting read; a fresh lease and edit must persist.
    const recoveredLease = openSessionLease();
    if (!recoveredLease) throw new Error('expected a fresh lease after authoritative recovery');
    await updateReplicaForLease(recoveredLease, (current) => ({
      ...current,
      notes: { ...current.notes, [noteCId]: note(noteCId, 'after') },
    }));
    const persisted = JSON.parse(repo.durable.get(ownerKey)!) as { notes: Record<string, Note> };
    expect(Object.keys(persisted.notes).sort()).toEqual([noteBId, noteCId].sort());
  });

  it('rejects the hot-path durable promise on a fence after adopting the winner', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);

    const applied = applyReplicaForLease(lease, (current) => ({
      next: { ...current, notes: { [noteAId]: note(noteAId, 'loser') } },
      result: 'created',
    }));

    await expect(applied.durable).rejects.toBeInstanceOf(ReplicaCommitSupersededError);
    expect(store$.status.get()).toBe('error');
    expect(applied.result).toBe('created');
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
  });

  it('rejects writes while the authoritative reread is still in flight', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const gate = holdNextRead(ownerKey);
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);

    const losing = applyReplicaForLease(lease, (current) => ({
      next: {
        ...current,
        notes: { ...current.notes, [noteAId]: note(noteAId, 'first loser') },
      },
      result: undefined,
    }));
    const losingResult = losing.durable.catch((error: unknown) => error);

    await gate.started;
    const commitCountDuringRead = repo.commits.length;
    let lateReducerRan = false;
    expect(() =>
      applyReplicaForLease(lease, (current) => {
        lateReducerRan = true;
        return {
          next: {
            ...current,
            notes: { ...current.notes, [noteCId]: note(noteCId, 'late loser') },
          },
          result: undefined,
        };
      }),
    ).toThrow(StaleSessionError);

    expect(lateReducerRan).toBe(false);
    expect(repo.commits).toHaveLength(commitCountDuringRead);
    gate.unblock();
    expect(await losingResult).toBeInstanceOf(ReplicaCommitSupersededError);

    const persisted = JSON.parse(repo.durable.get(ownerKey)!) as {
      notes: Record<string, Note>;
    };
    expect(Object.keys(persisted.notes)).toEqual([noteBId]);
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
  });
  it('awaits a valid in-flight recovery before allowing sign-out', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const gate = holdNextRead(ownerKey);
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);

    const losing = applyReplicaForLease(lease, (current) => ({
      next: {
        ...current,
        notes: { ...current.notes, [noteAId]: note(noteAId, 'first loser') },
      },
      result: undefined,
    }));
    const losingResult = losing.durable.catch((error: unknown) => error);
    await gate.started;

    const signOutResult = signOutSession().catch((error: unknown) => error);
    await Promise.resolve();
    expect(store$.session.get()).toEqual(sessionA);

    gate.unblock();
    expect(await losingResult).toBeInstanceOf(ReplicaCommitSupersededError);
    expect(await signOutResult).toBeInstanceOf(ReplicaCommitSupersededError);
    expect(store$.session.get()).toEqual(sessionA);
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
    expect(store$.status.get()).toBe('error');
  });
  it('blocks synchronous reducer re-entry while publishing the winner', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);

    let observerAttempted = false;
    let observerReducerRan = false;
    let observerError: unknown;
    let observerDurable: Promise<void> | null = null;
    const dispose = store$.onChange(({ value }) => {
      if (observerAttempted || value.notes[noteBId]?.bodyMd !== 'winner') return;
      observerAttempted = true;
      try {
        const reentered = applyReplicaForLease(lease, (current) => {
          observerReducerRan = true;
          return {
            next: {
              ...current,
              notes: { ...current.notes, [noteCId]: note(noteCId, 'observer loser') },
            },
            result: undefined,
          };
        });
        observerDurable = reentered.durable;
        void reentered.durable.catch((error: unknown) => (observerError ??= error));
      } catch (error) {
        observerError = error;
      }
    });

    const losing = applyReplicaForLease(lease, (current) => ({
      next: {
        ...current,
        notes: { ...current.notes, [noteAId]: note(noteAId, 'first loser') },
      },
      result: undefined,
    }));
    await expect(losing.durable).rejects.toBeInstanceOf(ReplicaCommitSupersededError);
    dispose();

    expect(observerAttempted).toBe(true);
    expect(observerReducerRan).toBe(false);
    expect(observerError).toBeInstanceOf(StaleSessionError);
    expect(observerDurable).toBeNull();
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
    const persisted = JSON.parse(repo.durable.get(ownerKey)!) as { notes: Record<string, Note> };
    expect(Object.keys(persisted.notes)).toEqual([noteBId]);
  });
  it('single-flights recovery for every queued optimistic loser', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const readsBeforeRace = repo.reads.filter((key) => key === ownerKey).length;
    const gate = holdNextRead(ownerKey);
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);

    const first = applyReplicaForLease(lease, (current) => ({
      next: {
        ...current,
        notes: { ...current.notes, [noteAId]: note(noteAId, 'first loser') },
      },
      result: undefined,
    }));
    const second = applyReplicaForLease(lease, (current) => ({
      next: {
        ...current,
        notes: { ...current.notes, [noteCId]: note(noteCId, 'second loser') },
      },
      result: undefined,
    }));

    const settledPromise = Promise.allSettled([first.durable, second.durable]);
    await gate.started;
    gate.unblock();
    const settled = await settledPromise;
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of settled) {
      if (result.status !== 'rejected') throw new Error('expected a superseded commit');
      expect(result.reason).toBeInstanceOf(ReplicaCommitSupersededError);
    }

    expect(repo.reads.filter((key) => key === ownerKey)).toHaveLength(readsBeforeRace + 1);
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
    const persisted = JSON.parse(repo.durable.get(ownerKey)!) as { notes: Record<string, Note> };
    expect(Object.keys(persisted.notes)).toEqual([noteBId]);
    const candidates = recoveryEnvelope(ownerKey).envelope.snapshots.map((snapshot) => {
      const replica = JSON.parse(snapshot.serializedReplica) as { notes: Record<string, Note> };
      return Object.keys(replica.notes).sort();
    });
    expect(candidates).toEqual([[noteAId], [noteAId, noteCId].sort()]);
  });

  it('rejects a superseded commit without replacing the authoritative winner', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);

    await expect(
      updateReplicaForLease(lease, (current) => ({
        ...current,
        notes: { ...current.notes, [noteAId]: note(noteAId, 'loser') },
      })),
    ).rejects.toBeInstanceOf(ReplicaCommitSupersededError);

    // Neither the losing edit nor the pre-edit projection: the authoritative winner.
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
  });

  it('keeps later writes fenced when the authoritative winner is missing', async () => {
    await expectUnreadableWinnerIsFenced(() => null);
  });

  it('keeps later writes fenced when the authoritative winner is corrupt', async () => {
    await expectUnreadableWinnerIsFenced(() => '{');
  });

  it('keeps later writes fenced when the authoritative winner uses a future schema', async () => {
    await expectUnreadableWinnerIsFenced((deviceId) => {
      const current = JSON.parse(
        winnerBytes({ [noteBId]: note(noteBId, 'future') }, deviceId),
      ) as Record<string, unknown>;
      return JSON.stringify({ ...current, version: 3 });
    });
  });

  it('keeps later writes fenced when the authoritative winner has a malformed scalar', async () => {
    await expectUnreadableWinnerIsFenced((deviceId) => {
      const current = JSON.parse(
        winnerBytes({ [noteBId]: note(noteBId, 'malformed') }, deviceId),
      ) as Record<string, unknown>;
      return JSON.stringify({ ...current, syncCursor: 42 });
    });
  });

  it.each([
    ['missing', () => null],
    ['corrupt', () => '{'],
    [
      'future-version',
      (deviceId: string) => {
        const current = JSON.parse(
          winnerBytes({ [noteBId]: note(noteBId, 'future') }, deviceId),
        ) as Record<string, unknown>;
        return JSON.stringify({ ...current, version: 3 });
      },
    ],
  ] as const)(
    'rehydrates the recovery candidate read-only after a %s winner, sign-out, and login',
    async (_caseName, buildWinner) => {
      const lease = await signIn();
      const ownerKey = ownerKeyFor(sessionA);
      const localNote = note(noteAId, 'last readable local draft');
      const localMutation = mutation(noteAId, 'op-last-readable', localNote.bodyMd);
      await updateReplicaForLease(lease, (current) => ({
        ...current,
        notes: { [localNote.id]: localNote },
        outbox: [localMutation],
      }));

      repo.winner.set(ownerKey, buildWinner(store$.deviceId.get()));
      repo.raceNextCommit.add(ownerKey);
      expect(await saveState()).toBe(false);

      const unreadableBytes = repo.durable.get(ownerKey);
      const ownerCommitCount = repo.commits.filter((key) => key === ownerKey).length;
      const preservedBytes =
        recoveryEnvelope(ownerKey).envelope.snapshots.at(-1)!.serializedReplica;

      await signOutSession();
      expect(store$.session.get()).toBeNull();
      await adoptSession(sessionA);

      expect(store$.session.get()).toEqual(sessionA);
      expect(store$.status.get()).toBe('recovery-required');
      expect(store$.notes.get()).toEqual({ [localNote.id]: localNote });
      expect(store$.outbox.get()).toEqual([localMutation]);
      expect(openSessionLease()).toBeNull();
      expect(repo.durable.get(ownerKey)).toBe(unreadableBytes);
      expect(repo.commits.filter((key) => key === ownerKey)).toHaveLength(ownerCommitCount);
      expect(recoveryEnvelope(ownerKey).envelope.snapshots.at(-1)!.serializedReplica).toBe(
        preservedBytes,
      );
    },
  );

  it('falls back to a compatible journal when the transactional primary read rejects', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const localNote = note(noteAId, 'recovery after rejected primary read');
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [localNote.id]: localNote },
    }));

    repo.winner.set(ownerKey, '{');
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);
    await signOutSession();

    repo.failReadKey = ownerKey;
    await adoptSession(sessionA);

    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.status.get()).toBe('recovery-required');
    expect(store$.notes.get()).toEqual({ [localNote.id]: localNote });
    expect(openSessionLease()).toBeNull();
    expect(repo.durable.get(ownerKey)).toBe('{');
  });

  it('expires the same active credential after recovery invalidates its original lease', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const localNote = note(noteAId, 'draft before active-token rejection');
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [localNote.id]: localNote },
    }));
    repo.winner.set(ownerKey, '{');
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);
    expect(store$.status.get()).toBe('recovery-required');

    expect(await expireSessionIfCurrent(lease)).toBe(true);

    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('auth-required');
    expect(memory.values.get(stateStorageKeys.session)).not.toContain(sessionA.token);
    expect(recoveryEnvelope(ownerKey).envelope.snapshots).not.toHaveLength(0);
  });

  it('signs out without rewriting an unreadable authoritative root', async () => {
    await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(ownerKey, '{');
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);

    const unreadableBytes = repo.durable.get(ownerKey);
    const ownerCommitCount = repo.commits.filter((key) => key === ownerKey).length;
    await signOutSession();

    expect(store$.session.get()).toBeNull();
    expect(store$.activeOwnerKey.get()).toBeNull();
    expect(store$.status.get()).toBe('idle');
    expect(repo.durable.get(ownerKey)).toBe(unreadableBytes);
    expect(repo.commits.filter((key) => key === ownerKey)).toHaveLength(ownerCommitCount);
  });

  it('switches accounts without rewriting an unreadable authoritative root', async () => {
    await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(ownerKey, '{');
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);

    const unreadableBytes = repo.durable.get(ownerKey);
    const ownerCommitCount = repo.commits.filter((key) => key === ownerKey).length;
    await adoptSession(sessionB);

    expect(store$.session.get()).toEqual(sessionB);
    expect(store$.activeOwnerKey.get()).toBe(ownerKeyFor(sessionB));
    expect(repo.durable.get(ownerKey)).toBe(unreadableBytes);
    expect(repo.commits.filter((key) => key === ownerKey)).toHaveLength(ownerCommitCount);
  });
  it('journals an optimistic 401 snapshot before tombstoning the rejected credential', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const localNote = note(noteAId, 'draft present when the server rejected the token');
    const localMutation = mutation(noteAId, 'op-before-401', localNote.bodyMd);
    repo.failCommitKey = ownerKey;
    const optimistic = applyReplicaForLease(lease, (current) => ({
      next: {
        ...current,
        notes: { [localNote.id]: localNote },
        outbox: [localMutation],
      },
      result: undefined,
    }));
    await expect(optimistic.durable).rejects.toBeInstanceOf(StatePersistenceError);
    repo.failCommitKey = ownerKey;

    expect(await expireSessionIfCurrent(lease)).toBe(true);
    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('auth-required');

    const credential = memory.values.get(stateStorageKeys.session);
    expect(credential).toBeDefined();
    expect(credential).not.toContain(sessionA.token);
    expect(JSON.parse(credential!)).toMatchObject({
      version: 2,
      state: 'signed-out',
      reason: 'rejected',
      ownerKey,
    });

    const recovery = recoveryEnvelope(ownerKey).envelope;
    expect(recovery.snapshots.at(-1)?.reason).toBe('session-rejected');
    const preserved = JSON.parse(recovery.snapshots.at(-1)!.serializedReplica) as {
      notes: Record<string, Note>;
      outbox: SyncMutation[];
    };
    expect(preserved.notes).toEqual({ [localNote.id]: localNote });
    expect(preserved.outbox).toEqual([localMutation]);
  });

  it('tombstones a 401 credential but throws when local recovery cannot be verified', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    const localNote = note(noteAId, 'unverifiable 401 draft');
    repo.failCommitKey = ownerKey;
    const optimistic = applyReplicaForLease(lease, (current) => ({
      next: { ...current, notes: { [localNote.id]: localNote } },
      result: undefined,
    }));
    await expect(optimistic.durable).rejects.toBeInstanceOf(StatePersistenceError);

    repo.durable.set(recoveryKey, '{');
    repo.failCommitKey = ownerKey;
    await expect(expireSessionIfCurrent(lease)).rejects.toThrow(
      'local recovery snapshot could not be verified',
    );

    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('auth-required');
    const credential = memory.values.get(stateStorageKeys.session);
    expect(credential).toBeDefined();
    expect(credential).not.toContain(sessionA.token);
    expect(JSON.parse(credential!)).toMatchObject({
      state: 'signed-out',
      reason: 'rejected',
      ownerKey,
    });
    expect(repo.durable.get(recoveryKey)).toBe('{');

    repo.durable.delete(recoveryKey);
    await adoptSession(sessionA);

    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.status.get()).toBe('recovery-required');
    expect(store$.notes.get()).toEqual({ [localNote.id]: localNote });
    expect(openSessionLease()).toBeNull();
    expect(recoveryEnvelope(ownerKey).envelope.snapshots.at(-1)?.reason).toBe('session-rejected');
  });

  it('fails closed when an unreadable primary has a malformed recovery journal', async () => {
    await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    repo.durable.set(ownerKey, '{');
    repo.durable.set(recoveryKey, '{');
    const commitsBeforeLoad = [...repo.commits];

    await loadState();

    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('error');
    expect(repo.durable.get(ownerKey)).toBe('{');
    expect(repo.durable.get(recoveryKey)).toBe('{');
    expect(repo.commits).toEqual(commitsBeforeLoad);
  });

  it('refuses sign-out when the fenced recovery candidate cannot be verified', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const localNote = note(noteAId, 'must remain reachable');
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [localNote.id]: localNote },
    }));
    repo.winner.set(ownerKey, '{');
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);
    expect(store$.status.get()).toBe('recovery-required');

    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    repo.durable.set(recoveryKey, '{');
    const sessionRaw = memory.values.get(stateStorageKeys.session);
    const unreadablePrimary = repo.durable.get(ownerKey);

    await expect(signOutSession()).rejects.toBeInstanceOf(StatePersistenceError);

    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.notes.get()).toEqual({ [localNote.id]: localNote });
    expect(store$.status.get()).toBe('recovery-required');
    expect(openSessionLease()).toBeNull();
    expect(memory.values.get(stateStorageKeys.session)).toBe(sessionRaw);
    expect(repo.durable.get(ownerKey)).toBe(unreadablePrimary);

    repo.durable.delete(recoveryKey);
    await signOutSession();
    expect(store$.session.get()).toBeNull();
    expect(recoveryEnvelope(ownerKey).envelope.snapshots).not.toHaveLength(0);
  });

  it('refuses an account switch when the fenced recovery candidate cannot be verified', async () => {
    const lease = await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    const localNote = note(noteAId, 'must survive a refused account switch');
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [localNote.id]: localNote },
    }));
    repo.winner.set(ownerKey, '{');
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);

    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    repo.durable.set(recoveryKey, '{');
    const sessionRaw = memory.values.get(stateStorageKeys.session);

    await expect(adoptSession(sessionB)).rejects.toBeInstanceOf(StatePersistenceError);

    expect(store$.session.get()).toEqual(sessionA);
    expect(store$.notes.get()).toEqual({ [localNote.id]: localNote });
    expect(store$.status.get()).toBe('recovery-required');
    expect(memory.values.get(stateStorageKeys.session)).toBe(sessionRaw);

    repo.durable.delete(recoveryKey);
    await signOutSession();
  });

  it('keeps the session active when its final save is superseded during sign-out', async () => {
    await signIn();
    const ownerKey = ownerKeyFor(sessionA);
    repo.winner.set(
      ownerKey,
      winnerBytes({ [noteBId]: note(noteBId, 'winner') }, store$.deviceId.get()),
    );
    repo.raceNextCommit.add(ownerKey);

    await expect(signOutSession()).rejects.toBeInstanceOf(ReplicaCommitSupersededError);
    expect(store$.session.get()).toEqual(sessionA);
    expect(Object.keys(store$.notes.get())).toEqual([noteBId]);
    expect(store$.status.get()).toBe('error');
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

afterEach(() => {
  for (const release of repo.readGateReleases) release();
  repo.readGateReleases.clear();
});
