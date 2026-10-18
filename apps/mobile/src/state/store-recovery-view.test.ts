import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '@iris/shared';
import type { OwnerAuthorityHooks } from './owner-replica-authority';

const memory = vi.hoisted(() => ({ values: new Map<string, string>() }));
const fetchCalls = vi.hoisted(() => ({ count: 0 }));

const repo = vi.hoisted(() => ({
  durable: new Map<string, string>(),
  fenced: new Set<string>(),
  raceNextCommit: new Set<string>(),
  winner: new Map<string, string | null>(),
  staleAlways: new Set<string>(),
  failReadKey: null as string | null,
  failCommitKey: null as string | null,
  prepareError: null as Error | null,
  role: 'leader' as 'leader' | 'follower' | 'acquiring' | 'unavailable',
  readGates: new Map<
    string,
    {
      started: Promise<void>;
      markStarted: () => void;
      unblocked: Promise<void>;
      unblock: () => void;
    }
  >(),
  makeStaleError: null as ((ownerKey: string) => Error) | null,
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
      if (repo.failReadKey === ownerKey) throw new Error('injected invalid record');
      const gate = repo.readGates.get(ownerKey);
      if (gate) {
        repo.readGates.delete(ownerKey);
        gate.markStarted();
        await gate.unblocked;
      }
      repo.fenced.delete(ownerKey);
      return repo.durable.get(ownerKey) ?? null;
    },
    async commit(ownerKey: string, raw: string): Promise<void> {
      repo.commits.push(ownerKey);
      if (repo.failCommitKey === ownerKey) {
        repo.failCommitKey = null;
        throw new Error('injected commit failure');
      }
      if (repo.staleAlways.has(ownerKey) || repo.fenced.has(ownerKey)) {
        repo.fenced.add(ownerKey);
        throw repo.makeStaleError!(ownerKey);
      }
      if (repo.raceNextCommit.has(ownerKey)) {
        repo.raceNextCommit.delete(ownerKey);
        const winner = repo.winner.get(ownerKey);
        if (winner === null) repo.durable.delete(ownerKey);
        else if (winner !== undefined) repo.durable.set(ownerKey, winner);
        repo.fenced.add(ownerKey);
        throw repo.makeStaleError!(ownerKey);
      }
      repo.durable.set(ownerKey, raw);
    },
    async erase(ownerKey: string): Promise<void> {
      repo.durable.delete(ownerKey);
    },
  };
  return {
    ownerReplicaRepository: repository,
    ownerReplicaRuntime: {
      repository,
      recoveryRepository: repository,
      mode: 'transactional-native',
      readFollower: (ownerKey: string) => repository.read(ownerKey),
      prepareOwner: async () => {
        if (repo.prepareError) throw repo.prepareError;
      },
      verifyBeforeNetwork: async () => undefined,
      authority: {
        async start(ownerKey: string, hooks: OwnerAuthorityHooks) {
          const acquiring = { ownerKey, epoch: 1, role: 'acquiring' as const };
          hooks.onRole(acquiring);
          try {
            await hooks.prepareLeader(acquiring);
          } catch {
            const unavailable = { ownerKey, epoch: 1, role: 'unavailable' as const };
            hooks.onRole(unavailable);
            return {
              snapshot: () => unavailable,
              publishRefresh: () => undefined,
              close: async () => undefined,
            };
          }
          hooks.onRole({ ownerKey, epoch: 2, role: 'leader' });
          return {
            snapshot: () => ({ ownerKey, epoch: 2, role: repo.role }),
            publishRefresh: () => undefined,
            close: async () => undefined,
          };
        },
      },
    },
  };
});

import { replicaRecoveryJournalOwnerKey } from './replica-recovery-journal';
import { replicaRecoveryViewOwnerKey } from './replica-recovery-selection';
import { ReplicaRepositoryStaleWriterError } from './transactional-replica-repository';
import {
  adoptSession,
  loadState,
  openRecoveryInspectionLease,
  openSessionLease,
  ownerKeyFor,
  showReplicaRecoverySnapshotForLease,
  saveState,
  showStoredPrimaryForLease,
  StaleSessionError,
  stateStorageKeys,
  StatePersistenceError,
  store$,
  updateReplicaForLease,
  type Session,
} from './store';

repo.makeStaleError = (ownerKey: string) => new ReplicaRepositoryStaleWriterError(ownerKey);

const workspaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userA = '11111111-1111-4111-8111-111111111111';
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
  ...sessionA,
  token: 'token-B-secret',
  userId: '22222222-2222-4222-8222-222222222222',
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

function winnerBytes(bodyMd: string, deviceId = 'device-primary'): string {
  return JSON.stringify({
    version: 2,
    ownerKey: ownerKeyFor(sessionA),
    userId: sessionA.userId,
    workspaceId: sessionA.workspaceId,
    notes: { [noteAId]: note(noteAId, bodyMd) },
    syncCursor: '',
    deviceId,
    outbox: [],
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
  });
}

function writeJournal(
  ownerKey: string,
  branches: {
    bodyMd: string;
    reason: 'stale-writer' | 'legacy-divergence' | 'primary-divergence' | 'promotion-baseline';
  }[],
): string {
  const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
  const raw = JSON.stringify({
    version: 1,
    ownerKey: recoveryKey,
    sourceOwnerKey: ownerKey,
    snapshots: branches.map((branch, index) => ({
      sequence: index + 1,
      capturedAt: `2026-07-19T20:0${index}:00.000Z`,
      reason: branch.reason,
      serializedReplica: winnerBytes(branch.bodyMd, 'device-' + branch.reason),
    })),
  });
  repo.durable.set(recoveryKey, raw);
  return raw;
}

async function fenceOnPrimary(bodyMd: string): Promise<{ ownerKey: string; primary: string }> {
  const ownerKey = ownerKeyFor(sessionA);
  const primary = winnerBytes(bodyMd, 'device-native-primary');
  memory.values.set(stateStorageKeys.session, JSON.stringify(sessionA));
  repo.durable.set(ownerKey, primary);
  repo.prepareError = new Error('injected preparation failure');
  await loadState();
  return { ownerKey, primary };
}

function inspectionLease() {
  const lease = openRecoveryInspectionLease();
  if (!lease) throw new Error('expected a recovery inspection lease');
  return lease;
}

beforeEach(async () => {
  memory.values.clear();
  repo.durable.clear();
  repo.fenced.clear();
  repo.raceNextCommit.clear();
  repo.winner.clear();
  repo.staleAlways.clear();
  repo.failReadKey = null;
  repo.failCommitKey = null;
  repo.prepareError = null;
  repo.role = 'leader';
  repo.readGates.clear();
  repo.commits = [];
  fetchCalls.count = 0;
  vi.stubGlobal('fetch', () => {
    fetchCalls.count += 1;
    return Promise.reject(new Error('recovery view must not fetch'));
  });
  await loadState();
});

describe('recovery view selection', () => {
  it('shows a journal snapshot without writing the primary, legacy root, or journal', async () => {
    const { ownerKey, primary } = await fenceOnPrimary('stored primary');
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    const journalRaw = writeJournal(ownerKey, [
      { bodyMd: 'stored primary', reason: 'promotion-baseline' },
      { bodyMd: 'older branch', reason: 'stale-writer' },
      { bodyMd: 'diverged branch', reason: 'legacy-divergence' },
    ]);
    const commitsBefore = [...repo.commits];

    const inspection = await showReplicaRecoverySnapshotForLease(inspectionLease(), 2);

    expect(store$.status.get()).toBe('recovery-required');
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('older branch');
    expect(store$.deviceId.get()).toBe('device-stale-writer');
    expect(openSessionLease()).toBeNull();
    expect(repo.durable.get(ownerKey)).toBe(primary);
    expect(repo.durable.get(recoveryKey)).toBe(journalRaw);
    expect(repo.durable.get(replicaRecoveryViewOwnerKey(ownerKey))).toContain('older branch');
    expect(inspection.viewSource).toBe('recovery-selection');
    expect(inspection.selectedSequence).toBe(2);
    expect(inspection.catalog?.copies).toHaveLength(3);
    expect(fetchCalls.count).toBe(0);
    expect(repo.commits.filter((key) => key !== replicaRecoveryViewOwnerKey(ownerKey))).toEqual(
      commitsBefore.filter((key) => key !== replicaRecoveryViewOwnerKey(ownerKey)),
    );

    await loadState();

    expect(store$.status.get()).toBe('recovery-required');
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('older branch');
    expect(repo.durable.get(ownerKey)).toBe(primary);
    expect(repo.durable.get(recoveryKey)).toBe(journalRaw);
    expect(openSessionLease()).toBeNull();
    expect(fetchCalls.count).toBe(0);
  });

  it('does not write a selection when the chosen snapshot is already on screen', async () => {
    const { ownerKey, primary } = await fenceOnPrimary('stored primary');
    writeJournal(ownerKey, [{ bodyMd: 'stored primary', reason: 'promotion-baseline' }]);
    repo.durable.set(
      replicaRecoveryJournalOwnerKey(ownerKey),
      JSON.stringify({
        version: 1,
        ownerKey: replicaRecoveryJournalOwnerKey(ownerKey),
        sourceOwnerKey: ownerKey,
        snapshots: [
          {
            sequence: 1,
            capturedAt: '2026-07-19T20:00:00.000Z',
            reason: 'promotion-baseline',
            serializedReplica: primary,
          },
        ],
      }),
    );
    const commitsBefore = [...repo.commits];

    await showReplicaRecoverySnapshotForLease(inspectionLease(), 1);

    expect(repo.durable.has(replicaRecoveryViewOwnerKey(ownerKey))).toBe(false);
    expect(repo.commits).toEqual(commitsBefore);
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('stored primary');
    expect(repo.durable.get(ownerKey)).toBe(primary);
  });

  it('returns to the stored primary and keeps the fence', async () => {
    const { ownerKey, primary } = await fenceOnPrimary('stored primary');
    const journalRaw = writeJournal(ownerKey, [
      { bodyMd: 'stored primary', reason: 'promotion-baseline' },
      { bodyMd: 'older branch', reason: 'stale-writer' },
    ]);
    await showReplicaRecoverySnapshotForLease(inspectionLease(), 2);

    const inspection = await showStoredPrimaryForLease(inspectionLease());

    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('stored primary');
    expect(store$.status.get()).toBe('recovery-required');
    expect(openSessionLease()).toBeNull();
    expect(repo.durable.has(replicaRecoveryViewOwnerKey(ownerKey))).toBe(false);
    expect(repo.durable.get(ownerKey)).toBe(primary);
    expect(repo.durable.get(replicaRecoveryJournalOwnerKey(ownerKey))).toBe(journalRaw);
    expect(inspection.viewSource).toBe('stored-primary');
    expect(inspection.selectedSequence).toBeNull();
    expect(fetchCalls.count).toBe(0);

    await loadState();
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('stored primary');
    expect(store$.status.get()).toBe('recovery-required');
    expect(repo.durable.get(ownerKey)).toBe(primary);
  });

  it('leaves the selection in place when the stored primary cannot be verified', async () => {
    const { ownerKey, primary } = await fenceOnPrimary('stored primary');
    writeJournal(ownerKey, [
      { bodyMd: 'stored primary', reason: 'promotion-baseline' },
      { bodyMd: 'older branch', reason: 'stale-writer' },
    ]);
    await showReplicaRecoverySnapshotForLease(inspectionLease(), 2);
    const selection = repo.durable.get(replicaRecoveryViewOwnerKey(ownerKey));
    repo.failReadKey = ownerKey;

    await expect(showStoredPrimaryForLease(inspectionLease())).rejects.toThrow(
      'The stored primary could not be verified',
    );

    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('older branch');
    expect(repo.durable.get(replicaRecoveryViewOwnerKey(ownerKey))).toBe(selection);
    expect(repo.durable.get(ownerKey)).toBe(primary);
  });

  it('refuses a healthy session, a follower, and an acquiring tab before writing', async () => {
    await adoptSession(sessionA);
    const ownerKey = ownerKeyFor(sessionA);
    writeJournal(ownerKey, [{ bodyMd: 'branch', reason: 'stale-writer' }]);
    await expect(showReplicaRecoverySnapshotForLease(inspectionLease(), 1)).rejects.toBeInstanceOf(
      StatePersistenceError,
    );
    expect(repo.durable.has(replicaRecoveryViewOwnerKey(ownerKey))).toBe(false);

    const lease = openSessionLease();
    if (!lease) throw new Error('expected a writable lease');
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { [noteAId]: note(noteAId, 'loser') },
    }));
    repo.winner.set(ownerKey, '{');
    repo.raceNextCommit.add(ownerKey);
    expect(await saveState()).toBe(false);
    expect(store$.status.get()).toBe('recovery-required');
    repo.role = 'follower';
    await expect(showReplicaRecoverySnapshotForLease(inspectionLease(), 1)).rejects.toThrow(
      /cannot change the recovery view/,
    );
    repo.role = 'acquiring';
    await expect(showStoredPrimaryForLease(inspectionLease())).rejects.toThrow(
      /cannot change the recovery view/,
    );
    expect(repo.durable.has(replicaRecoveryViewOwnerKey(ownerKey))).toBe(false);
  });

  it('retries a stale selection write and keeps the previous projection when retries are exhausted', async () => {
    const { ownerKey, primary } = await fenceOnPrimary('stored primary');
    writeJournal(ownerKey, [
      { bodyMd: 'stored primary', reason: 'promotion-baseline' },
      { bodyMd: 'older branch', reason: 'stale-writer' },
    ]);
    const viewKey = replicaRecoveryViewOwnerKey(ownerKey);
    repo.raceNextCommit.add(viewKey);
    repo.winner.set(viewKey, '{"ownerKey":"concurrent"}');

    await showReplicaRecoverySnapshotForLease(inspectionLease(), 2);

    expect(repo.durable.get(viewKey)).toContain('older branch');
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('older branch');
    expect(repo.durable.get(ownerKey)).toBe(primary);

    repo.staleAlways.add(viewKey);
    await expect(showReplicaRecoverySnapshotForLease(inspectionLease(), 1)).rejects.toBeInstanceOf(
      StatePersistenceError,
    );
    expect(repo.durable.get(viewKey)).toContain('older branch');
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('older branch');
  });

  it('does not write a selection when the journal cannot be read or a copy is still memory-only', async () => {
    const { ownerKey } = await fenceOnPrimary('stored primary');
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    const journalRaw = writeJournal(ownerKey, [
      { bodyMd: 'stored primary', reason: 'promotion-baseline' },
      { bodyMd: 'older branch', reason: 'stale-writer' },
    ]);
    repo.failReadKey = recoveryKey;

    await expect(showReplicaRecoverySnapshotForLease(inspectionLease(), 2)).rejects.toBeInstanceOf(
      StatePersistenceError,
    );
    expect(repo.durable.has(replicaRecoveryViewOwnerKey(ownerKey))).toBe(false);
    expect(repo.durable.get(recoveryKey)).toBe(journalRaw);

    repo.failReadKey = null;
    repo.prepareError = null;
    await loadState();
    const lease = openSessionLease();
    if (!lease) throw new Error('expected a writable lease');
    await updateReplicaForLease(lease, (current) => ({
      ...current,
      notes: { ...current.notes, [noteBId]: note(noteBId, 'memory only') },
    }));
    repo.winner.set(ownerKey, winnerBytes('winner', store$.deviceId.get()));
    repo.raceNextCommit.add(ownerKey);
    repo.failCommitKey = recoveryKey;
    expect(await saveState()).toBe(false);
    expect(store$.status.get()).toBe('recovery-required');
    repo.failCommitKey = recoveryKey;

    await expect(showReplicaRecoverySnapshotForLease(inspectionLease(), 1)).rejects.toBeInstanceOf(
      StatePersistenceError,
    );
    expect(repo.durable.has(replicaRecoveryViewOwnerKey(ownerKey))).toBe(false);
  });

  it('drops a stale selection during hydration and then follows the ordinary primary', async () => {
    const { ownerKey, primary } = await fenceOnPrimary('stored primary');
    writeJournal(ownerKey, [{ bodyMd: 'stored primary', reason: 'promotion-baseline' }]);
    repo.durable.set(
      replicaRecoveryViewOwnerKey(ownerKey),
      JSON.stringify({
        version: 1,
        ownerKey: replicaRecoveryViewOwnerKey(ownerKey),
        sourceOwnerKey: ownerKey,
        sequence: 9,
        serializedReplica: winnerBytes('missing branch', 'device-missing'),
      }),
    );

    await loadState();

    expect(repo.durable.has(replicaRecoveryViewOwnerKey(ownerKey))).toBe(false);
    expect(store$.notes.get()[noteAId]?.bodyMd).toBe('stored primary');
    expect(store$.status.get()).toBe('recovery-required');
    expect(repo.durable.get(ownerKey)).toBe(primary);
  });

  it('aborts a show when the account changes before the selection write', async () => {
    const { ownerKey, primary } = await fenceOnPrimary('stored primary');
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    writeJournal(ownerKey, [
      { bodyMd: 'stored primary', reason: 'promotion-baseline' },
      { bodyMd: 'older branch', reason: 'stale-writer' },
    ]);
    let markStarted!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const unblocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    repo.readGates.set(recoveryKey, { started, markStarted, unblocked, unblock });
    const pending = showReplicaRecoverySnapshotForLease(inspectionLease(), 2);
    await started;
    repo.prepareError = null;
    await adoptSession(sessionB);
    unblock();

    await expect(pending).rejects.toBeInstanceOf(StaleSessionError);
    expect(repo.durable.has(replicaRecoveryViewOwnerKey(ownerKey))).toBe(false);
    expect(repo.durable.get(ownerKey)).toBe(primary);
    const journalAfterSwitch = repo.durable.get(recoveryKey) ?? '';
    expect(journalAfterSwitch).toContain('older branch');
    expect(journalAfterSwitch).toContain('stored primary');
    expect(store$.activeOwnerKey.get()).toBe(ownerKeyFor(sessionB));
  });

  it('aborts a show when a session reload invalidates the inspection lease', async () => {
    const { ownerKey, primary } = await fenceOnPrimary('stored primary');
    const recoveryKey = replicaRecoveryJournalOwnerKey(ownerKey);
    writeJournal(ownerKey, [
      { bodyMd: 'stored primary', reason: 'promotion-baseline' },
      { bodyMd: 'older branch', reason: 'stale-writer' },
    ]);
    let markStarted!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const unblocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    repo.readGates.set(recoveryKey, { started, markStarted, unblocked, unblock });
    const pending = showReplicaRecoverySnapshotForLease(inspectionLease(), 2);
    await started;
    const reloaded = loadState();
    unblock();

    await expect(pending).rejects.toBeInstanceOf(StaleSessionError);
    await reloaded;
    expect(repo.durable.has(replicaRecoveryViewOwnerKey(ownerKey))).toBe(false);
    expect(repo.durable.get(ownerKey)).toBe(primary);
  });
});
