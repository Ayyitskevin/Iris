import { describe, expect, it } from 'vitest';
import { assertSerializedReplicaOwner, type OwnerReplicaRepository } from './replica-repository';
import {
  type CompareAndSwapResult,
  TransactionalOwnerReplicaRepository,
  type TransactionalReplicaRecord,
  type TransactionalReplicaStore,
} from './transactional-replica-repository';
import {
  parseReplicaRecoveryEnvelope,
  ReplicaRecoveryJournal,
  ReplicaRecoveryJournalError,
  replicaRecoveryJournalOwnerKey,
} from './replica-recovery-journal';

const sourceOwner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.11111111-1111-4111-8111-111111111111';

function replica(label: string, ownerKey = sourceOwner): string {
  return JSON.stringify({
    version: 2,
    ownerKey,
    userId: ownerKey.split('.')[1],
    workspaceId: ownerKey.split('.')[0],
    notes: {},
    syncCursor: label,
    deviceId: 'device-test',
    outbox: [],
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
  });
}

class MemoryOwnerRepository implements OwnerReplicaRepository {
  readonly values = new Map<string, string>();
  commits = 0;
  failCommit = false;

  async read(ownerKey: string): Promise<string | null> {
    return this.values.get(ownerKey) ?? null;
  }

  async commit(ownerKey: string, serializedReplica: string): Promise<void> {
    assertSerializedReplicaOwner(ownerKey, serializedReplica);
    this.commits += 1;
    if (this.failCommit) throw new Error('injected recovery write failure');
    this.values.set(ownerKey, serializedReplica);
  }
}

class BarrierTransactionalStore implements TransactionalReplicaStore {
  private readonly values = new Map<string, TransactionalReplicaRecord>();
  private initialReads = 0;
  private releaseInitialReads!: () => void;
  private readonly initialReadsReleased = new Promise<void>((resolve) => {
    this.releaseInitialReads = resolve;
  });

  async read(ownerKey: string): Promise<TransactionalReplicaRecord | null> {
    const record = this.values.get(ownerKey);
    if (!record && ownerKey.startsWith('iris.recovery-journal.v1.') && this.initialReads < 2) {
      this.initialReads += 1;
      if (this.initialReads === 2) this.releaseInitialReads();
      await this.initialReadsReleased;
    }
    const current = this.values.get(ownerKey);
    return current ? { ...current } : null;
  }

  async compareAndSwap(
    ownerKey: string,
    expectedRevision: number,
    serializedReplica: string,
  ): Promise<CompareAndSwapResult> {
    const current = this.values.get(ownerKey) ?? null;
    if ((current?.revision ?? 0) !== expectedRevision) {
      return { status: 'conflict', record: current ? { ...current } : null };
    }
    const record: TransactionalReplicaRecord = {
      schemaVersion: 1,
      ownerKey,
      revision: expectedRevision + 1,
      serializedReplica,
    };
    this.values.set(ownerKey, record);
    return { status: 'committed', record: { ...record } };
  }
}

describe('ReplicaRecoveryJournal', () => {
  it('appends exact token-free roots with monotonic sequence and deduplicates exact bytes', async () => {
    const repository = new MemoryOwnerRepository();
    let tick = 0;
    const journal = new ReplicaRecoveryJournal(
      repository,
      () => '2026-07-19T10:00:0' + tick++ + '.000Z',
    );
    const first = replica('first');
    const second = replica('second');

    await journal.append(sourceOwner, first, 'stale-writer');
    await journal.append(sourceOwner, second, 'session-departure');
    await journal.append(sourceOwner, first, 'session-rejected');

    const envelope = await journal.read(sourceOwner);
    expect(envelope?.snapshots.map((snapshot) => snapshot.sequence)).toEqual([1, 2]);
    expect(envelope?.snapshots.map((snapshot) => snapshot.serializedReplica)).toEqual([
      first,
      second,
    ]);
    expect(repository.commits).toBe(2);
    const raw = repository.values.get(replicaRecoveryJournalOwnerKey(sourceOwner))!;
    expect(raw).not.toContain('bearer-secret');
    expect(() => parseReplicaRecoveryEnvelope(raw, sourceOwner)).not.toThrow();
  });

  it('serializes overlapping in-process appends without replacing either snapshot', async () => {
    const repository = new MemoryOwnerRepository();
    const journal = new ReplicaRecoveryJournal(repository, () => '2026-07-19T10:01:00.000Z');
    const roots = [replica('one'), replica('two'), replica('three')];

    await Promise.all(roots.map((root) => journal.append(sourceOwner, root, 'stale-writer')));

    const envelope = await journal.read(sourceOwner);
    expect(envelope?.snapshots.map((snapshot) => snapshot.serializedReplica)).toEqual(roots);
    expect(envelope?.snapshots.map((snapshot) => snapshot.sequence)).toEqual([1, 2, 3]);
  });

  it('merges a forced cross-instance CAS race instead of dropping a distinct root', async () => {
    const store = new BarrierTransactionalStore();
    const firstJournal = new ReplicaRecoveryJournal(
      new TransactionalOwnerReplicaRepository(store),
      () => '2026-07-19T10:02:00.000Z',
    );
    const secondJournal = new ReplicaRecoveryJournal(
      new TransactionalOwnerReplicaRepository(store),
      () => '2026-07-19T10:02:01.000Z',
    );
    const first = replica('tab-one');
    const second = replica('tab-two');

    await Promise.all([
      firstJournal.append(sourceOwner, first, 'stale-writer'),
      secondJournal.append(sourceOwner, second, 'stale-writer'),
    ]);

    const restarted = new ReplicaRecoveryJournal(new TransactionalOwnerReplicaRepository(store));
    const envelope = await restarted.read(sourceOwner);
    expect(envelope?.snapshots).toHaveLength(2);
    expect(new Set(envelope?.snapshots.map((snapshot) => snapshot.serializedReplica))).toEqual(
      new Set([first, second]),
    );
    expect(envelope?.snapshots.map((snapshot) => snapshot.sequence)).toEqual([1, 2]);
  });

  it('fails closed on malformed, foreign, or credential-bearing recovery data', async () => {
    const repository = new MemoryOwnerRepository();
    const recoveryOwner = replicaRecoveryJournalOwnerKey(sourceOwner);
    const validRoot = replica('valid');

    repository.values.set(
      recoveryOwner,
      JSON.stringify({
        version: 1,
        ownerKey: recoveryOwner,
        sourceOwnerKey: sourceOwner,
        snapshots: [
          {
            sequence: 1,
            capturedAt: '2026-07-19T10:03:00.000Z',
            reason: 'stale-writer',
            serializedReplica: replica('foreign', 'foreign.owner'),
          },
        ],
      }),
    );
    const journal = new ReplicaRecoveryJournal(repository);
    await expect(journal.read(sourceOwner)).rejects.toBeInstanceOf(ReplicaRecoveryJournalError);
    const commitsBefore = repository.commits;
    await expect(journal.append(sourceOwner, validRoot, 'stale-writer')).rejects.toBeInstanceOf(
      ReplicaRecoveryJournalError,
    );
    expect(repository.commits).toBe(commitsBefore);

    await expect(
      journal.append(
        sourceOwner,
        JSON.stringify({ ownerKey: sourceOwner, token: 'bearer-secret' }),
        'stale-writer',
      ),
    ).rejects.toBeInstanceOf(ReplicaRecoveryJournalError);
    await expect(
      journal.append(
        sourceOwner,
        JSON.stringify({ ...JSON.parse(validRoot), accessToken: 'bearer-secret' }),
        'stale-writer',
      ),
    ).rejects.toBeInstanceOf(ReplicaRecoveryJournalError);
    const nestedCredential = JSON.parse(validRoot) as Record<string, unknown>;
    const noteId = '33333333-3333-4333-8333-333333333333';
    nestedCredential.notes = {
      [noteId]: {
        id: noteId,
        workspaceId: sourceOwner.split('.')[0],
        title: 'Credential-shaped extension',
        bodyMd: 'ordinary note body',
        folder: null,
        tags: [],
        version: 1,
        createdAt: '2026-07-19T10:03:00.000Z',
        updatedAt: '2026-07-19T10:03:00.000Z',
        deletedAt: null,
        authToken: 'bearer-secret',
      },
    };
    await expect(
      journal.append(sourceOwner, JSON.stringify(nestedCredential), 'stale-writer'),
    ).rejects.toBeInstanceOf(ReplicaRecoveryJournalError);
  });

  it('rejects invalid capture metadata before writing a journal record', async () => {
    const repository = new MemoryOwnerRepository();
    const journal = new ReplicaRecoveryJournal(repository, () => 'not-an-iso-timestamp');

    await expect(
      journal.append(sourceOwner, replica('invalid-time'), 'stale-writer'),
    ).rejects.toBeInstanceOf(ReplicaRecoveryJournalError);
    expect(repository.commits).toBe(0);
    expect(repository.values.has(replicaRecoveryJournalOwnerKey(sourceOwner))).toBe(false);
  });

  it('surfaces an unverifiable append and never reports a recovery snapshot as durable', async () => {
    const repository = new MemoryOwnerRepository();
    repository.failCommit = true;
    const journal = new ReplicaRecoveryJournal(repository);

    await expect(
      journal.append(sourceOwner, replica('not-durable'), 'stale-writer'),
    ).rejects.toBeInstanceOf(ReplicaRecoveryJournalError);
    expect(repository.values.has(replicaRecoveryJournalOwnerKey(sourceOwner))).toBe(false);
  });
});
