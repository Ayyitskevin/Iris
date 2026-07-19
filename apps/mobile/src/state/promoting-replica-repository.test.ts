import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./storage', () => ({
  storage: { get: async () => null, set: async () => undefined, remove: async () => undefined },
}));

import {
  ReplicaDivergenceJournal,
  REPLICA_ROOT_DIGEST_DOMAIN,
  digestReplicaRoot,
  replicaDivergenceJournalOwnerKey,
  type ReplicaRootDigestFunction,
} from './replica-divergence-journal';
import {
  ExpoSqliteTransactionalReplicaStore,
  type ReplicaSqliteDatabase,
  type ReplicaSqliteParam,
  type ReplicaSqliteRunner,
} from './expo-sqlite-replica-store';
import {
  PromotingOwnerReplicaRepository,
  ReplicaRepositoryAuthorityError,
  ReplicaRepositoryDivergedError,
} from './promoting-replica-repository';
import { ReplicaRecoveryJournal, replicaRecoveryJournalOwnerKey } from './replica-recovery-journal';
import type { OwnerReplicaRepository } from './replica-repository';
import { TransactionalOwnerReplicaRepository } from './transactional-replica-repository';

class NodeSqliteReplicaDatabase implements ReplicaSqliteDatabase {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec('PRAGMA busy_timeout = 0');
  }

  async execAsync(source: string): Promise<void> {
    this.db.exec(source);
  }

  async getFirstAsync<T>(source: string, ...params: ReplicaSqliteParam[]): Promise<T | null> {
    return (this.db.prepare(source).get(...params) as T | undefined) ?? null;
  }

  async runAsync(source: string, ...params: ReplicaSqliteParam[]): Promise<unknown> {
    return this.db.prepare(source).run(...params);
  }

  async withExclusiveTransactionAsync(
    task: (txn: ReplicaSqliteRunner) => Promise<void>,
  ): Promise<void> {
    this.db.exec('BEGIN EXCLUSIVE');
    try {
      await task(this);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw error;
    }
  }
}

const connections: DatabaseSync[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

function sqliteRepo(): TransactionalOwnerReplicaRepository {
  const db = new DatabaseSync(':memory:');
  connections.push(db);
  return new TransactionalOwnerReplicaRepository(
    new ExpoSqliteTransactionalReplicaStore(new NodeSqliteReplicaDatabase(db)),
  );
}

class MemoryRepo implements OwnerReplicaRepository {
  readonly data = new Map<string, string>();
  readonly commits: string[] = [];
  failNextCommitFor: string | null = null;
  afterCommit: ((ownerKey: string, raw: string) => void | Promise<void>) | null = null;

  constructor(seed?: Record<string, string>) {
    if (seed) {
      for (const [ownerKey, raw] of Object.entries(seed)) this.data.set(ownerKey, raw);
    }
  }

  set(ownerKey: string, raw: string): void {
    this.data.set(ownerKey, raw);
  }

  async read(ownerKey: string): Promise<string | null> {
    return this.data.get(ownerKey) ?? null;
  }

  async commit(ownerKey: string, raw: string): Promise<void> {
    this.commits.push(ownerKey);
    if (this.failNextCommitFor === ownerKey) {
      this.failNextCommitFor = null;
      throw new Error('injected commit failure');
    }
    this.data.set(ownerKey, raw);
    await this.afterCommit?.(ownerKey, raw);
  }
}

const workspaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const ownerA = workspaceA + '.' + userA;
const ownerB = workspaceB + '.' + userB;

function serialized(ownerKey: string, marker: string): string {
  const [workspaceId, userId] = ownerKey.split('.');
  return JSON.stringify({
    version: 2,
    ownerKey,
    userId,
    workspaceId,
    notes: {},
    syncCursor: '',
    deviceId: 'device-' + marker,
    outbox: [],
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
  });
}

const testDigest: ReplicaRootDigestFunction = async (raw) => {
  if (raw === null) return Object.freeze({ kind: 'absent' as const });
  return Object.freeze({
    kind: 'sha256' as const,
    algorithm: 'SHA-256' as const,
    domain: REPLICA_ROOT_DIGEST_DOMAIN,
    hex: createHash('sha256')
      .update(REPLICA_ROOT_DIGEST_DOMAIN + '\u0000' + raw)
      .digest('hex'),
  });
};

function protocol(primary: OwnerReplicaRepository, legacy: OwnerReplicaRepository) {
  let tick = 0;
  const now = () => new Date(Date.parse('2026-07-19T18:00:00.000Z') + tick++ * 1000).toISOString();
  const divergence = new ReplicaDivergenceJournal(primary, now);
  const recovery = new ReplicaRecoveryJournal(primary, now);
  return {
    divergence,
    recovery,
    repository: new PromotingOwnerReplicaRepository(
      primary,
      legacy,
      divergence,
      recovery,
      testDigest,
    ),
  };
}

describe('PromotingOwnerReplicaRepository mixed-version protocol', () => {
  it('preserves a baseline, promotes through real SQLite, and keeps raw bytes out of control state', async () => {
    const primary = sqliteRepo();
    const baseline = serialized(ownerA, 'baseline-secret-sentinel');
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const { repository, divergence, recovery } = protocol(primary, legacy);

    expect(await repository.read(ownerA)).toBe(baseline);
    expect(await primary.read(ownerA)).toBe(baseline);
    expect((await divergence.read(ownerA))?.entries.map((entry) => entry.state)).toEqual([
      'preparing',
      'transactional',
    ]);
    expect((await recovery.read(ownerA))?.snapshots).toMatchObject([
      { sequence: 1, reason: 'promotion-baseline', serializedReplica: baseline },
    ]);

    const controlRaw = await primary.read(replicaDivergenceJournalOwnerKey(ownerA));
    const recoveryRaw = await primary.read(replicaRecoveryJournalOwnerKey(ownerA));
    expect(controlRaw).not.toContain('baseline-secret-sentinel');
    expect(controlRaw).not.toContain('serializedReplica');
    expect(recoveryRaw).toContain('baseline-secret-sentinel');
  });

  it('creates a fresh primary through preparing -> transactional with an absent baseline', async () => {
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo();
    const fresh = serialized(ownerA, 'fresh');
    const { repository, divergence } = protocol(primary, legacy);

    expect(await repository.read(ownerA)).toBeNull();
    await repository.commit(ownerA, fresh);

    expect(await primary.read(ownerA)).toBe(fresh);
    expect(await legacy.read(ownerA)).toBeNull();
    const journal = await divergence.read(ownerA);
    expect(journal?.legacyBaselineDigest).toEqual({ kind: 'absent' });
    expect(journal?.entries.map((entry) => [entry.state, entry.reason])).toEqual([
      ['preparing', 'commit'],
      ['transactional', 'commit'],
    ]);
  });

  it('compacts routine commit history without changing the verified primary', async () => {
    const baseline = serialized(ownerA, 'bounded-baseline');
    const next = serialized(ownerA, 'bounded-next');
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const divergence = new ReplicaDivergenceJournal(
      primary,
      () => '2026-07-19T18:00:00.000Z',
      8,
      3,
    );
    const recovery = new ReplicaRecoveryJournal(primary);
    const repository = new PromotingOwnerReplicaRepository(
      primary,
      legacy,
      divergence,
      recovery,
      testDigest,
    );

    await repository.read(ownerA);
    await repository.commit(ownerA, next);

    expect(await primary.read(ownerA)).toBe(next);
    expect((await divergence.read(ownerA))?.entries).toEqual([
      expect.objectContaining({
        sequence: 1,
        state: 'transactional',
        reason: 'checkpoint',
        primaryDigest: await testDigest(next),
      }),
    ]);
    await expect(repository.verifyBeforeNetwork(ownerA)).resolves.toBeUndefined();
  });

  it('adopts matching pre-existing roots without rewriting either root', async () => {
    const root = serialized(ownerA, 'matching');
    const primary = new MemoryRepo({ [ownerA]: root });
    const legacy = new MemoryRepo({ [ownerA]: root });
    const { repository, divergence, recovery } = protocol(primary, legacy);

    expect(await repository.read(ownerA)).toBe(root);
    expect(primary.commits.filter((ownerKey) => ownerKey === ownerA)).toEqual([]);
    expect((await divergence.read(ownerA))?.entries.map((entry) => entry.reason)).toEqual([
      'adopt-existing',
      'adopt-existing',
    ]);
    expect((await recovery.read(ownerA))?.snapshots[0]).toMatchObject({
      reason: 'promotion-baseline',
      serializedReplica: root,
    });
  });

  it('fails closed on unequal pre-existing roots and preserves both exact branches', async () => {
    const primaryRoot = serialized(ownerA, 'primary');
    const legacyRoot = serialized(ownerA, 'legacy');
    const primary = new MemoryRepo({ [ownerA]: primaryRoot });
    const legacy = new MemoryRepo({ [ownerA]: legacyRoot });
    const { repository, divergence, recovery } = protocol(primary, legacy);

    await expect(repository.prepareOwner(ownerA)).rejects.toBeInstanceOf(
      ReplicaRepositoryDivergedError,
    );
    expect(await primary.read(ownerA)).toBe(primaryRoot);
    expect(await legacy.read(ownerA)).toBe(legacyRoot);
    expect((await recovery.read(ownerA))?.snapshots.map((copy) => copy.serializedReplica)).toEqual([
      legacyRoot,
      legacyRoot,
      primaryRoot,
    ]);
    expect((await recovery.read(ownerA))?.snapshots.map((copy) => copy.reason)).toEqual([
      'promotion-baseline',
      'legacy-divergence',
      'primary-divergence',
    ]);
    expect((await divergence.read(ownerA))?.entries.at(-1)).toMatchObject({
      state: 'diverged',
      reason: 'primary-drift',
    });
  });

  it('does not bless unequal roots after a crash during pre-existing adoption', async () => {
    const primaryRoot = serialized(ownerA, 'crashed-adoption-primary');
    const legacyRoot = serialized(ownerA, 'crashed-adoption-legacy');
    const primary = new MemoryRepo({ [ownerA]: primaryRoot });
    const legacy = new MemoryRepo({ [ownerA]: legacyRoot });
    const divergence = new ReplicaDivergenceJournal(primary);
    const recovery = new ReplicaRecoveryJournal(primary);
    const legacyDigest = await testDigest(legacyRoot);
    const primaryDigest = await testDigest(primaryRoot);
    await recovery.append(ownerA, legacyRoot, 'promotion-baseline');
    await divergence.append(ownerA, legacyDigest, {
      state: 'preparing',
      reason: 'adopt-existing',
      legacyDigest,
      primaryDigest,
      targetPrimaryDigest: primaryDigest,
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    });
    const repository = new PromotingOwnerReplicaRepository(
      primary,
      legacy,
      divergence,
      recovery,
      testDigest,
    );

    await expect(repository.prepareOwner(ownerA)).rejects.toBeInstanceOf(
      ReplicaRepositoryDivergedError,
    );
    expect(await primary.read(ownerA)).toBe(primaryRoot);
    expect(await legacy.read(ownerA)).toBe(legacyRoot);
    expect((await recovery.read(ownerA))?.snapshots.map((copy) => copy.serializedReplica)).toEqual([
      legacyRoot,
      legacyRoot,
      primaryRoot,
    ]);
    expect((await divergence.read(ownerA))?.entries.at(-1)).toMatchObject({
      state: 'diverged',
      reason: 'primary-drift',
    });
  });

  it('detects a later old-runtime write before network, preserves both roots, and stays absorbing', async () => {
    const baseline = serialized(ownerA, 'baseline');
    const changedLegacy = serialized(ownerA, 'old-runtime-change');
    const attemptedPrimary = serialized(ownerA, 'must-not-land');
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const { repository, divergence, recovery } = protocol(primary, legacy);
    await repository.read(ownerA);

    legacy.set(ownerA, changedLegacy);
    await expect(repository.verifyBeforeNetwork(ownerA)).rejects.toBeInstanceOf(
      ReplicaRepositoryDivergedError,
    );

    expect(await primary.read(ownerA)).toBe(baseline);
    expect(await legacy.read(ownerA)).toBe(changedLegacy);
    const copies = (await recovery.read(ownerA))!.snapshots;
    expect(copies.map((copy) => copy.serializedReplica)).toEqual([
      baseline,
      changedLegacy,
      baseline,
    ]);
    const diverged = (await divergence.read(ownerA))!.entries.at(-1)!;
    expect(diverged).toMatchObject({
      state: 'diverged',
      reason: 'legacy-drift',
      legacyRecoverySequence: 2,
      primaryRecoverySequence: 3,
    });

    await expect(repository.commit(ownerA, attemptedPrimary)).rejects.toBeInstanceOf(
      ReplicaRepositoryDivergedError,
    );
    expect(await primary.read(ownerA)).toBe(baseline);
  });

  it('detects an unjournaled primary revision and preserves it without touching legacy', async () => {
    const baseline = serialized(ownerA, 'baseline');
    const changedPrimary = serialized(ownerA, 'unexpected-primary');
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const { repository, divergence, recovery } = protocol(primary, legacy);
    await repository.read(ownerA);

    primary.set(ownerA, changedPrimary);
    await expect(repository.prepareOwner(ownerA)).rejects.toBeInstanceOf(
      ReplicaRepositoryDivergedError,
    );

    expect((await divergence.read(ownerA))?.entries.at(-1)).toMatchObject({
      state: 'diverged',
      reason: 'primary-drift',
    });
    expect((await recovery.read(ownerA))?.snapshots.map((copy) => copy.serializedReplica)).toEqual([
      baseline,
      baseline,
      changedPrimary,
    ]);
    expect(await legacy.read(ownerA)).toBe(baseline);
  });

  it('keeps divergence absorbing while preserving a later old-runtime branch revision', async () => {
    const baseline = serialized(ownerA, 'baseline');
    const firstLegacy = serialized(ownerA, 'old-runtime-one');
    const laterLegacy = serialized(ownerA, 'old-runtime-two');
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const firstProtocol = protocol(primary, legacy);
    await firstProtocol.repository.read(ownerA);
    legacy.set(ownerA, firstLegacy);
    await expect(firstProtocol.repository.prepareOwner(ownerA)).rejects.toBeInstanceOf(
      ReplicaRepositoryDivergedError,
    );

    legacy.set(ownerA, laterLegacy);
    const resumedProtocol = protocol(primary, legacy);
    await expect(resumedProtocol.repository.prepareOwner(ownerA)).rejects.toBeInstanceOf(
      ReplicaRepositoryDivergedError,
    );

    expect(
      (await resumedProtocol.recovery.read(ownerA))?.snapshots.map(
        (copy) => copy.serializedReplica,
      ),
    ).toEqual([baseline, firstLegacy, baseline, laterLegacy]);
    expect(
      (await resumedProtocol.divergence.read(ownerA))?.entries
        .filter((entry) => entry.state === 'diverged')
        .map((entry) => entry.reason),
    ).toEqual(['legacy-drift', 'legacy-drift']);
    expect(await primary.read(ownerA)).toBe(baseline);
    expect(await legacy.read(ownerA)).toBe(laterLegacy);
  });

  it('fails closed when crash-preserved divergence evidence outlives a reverted source root', async () => {
    const baseline = serialized(ownerA, 'baseline');
    const transientLegacy = serialized(ownerA, 'orphaned-old-runtime-branch');
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const firstProtocol = protocol(primary, legacy);
    await firstProtocol.repository.read(ownerA);

    // markDiverged preserves exact branches before its absorbing control append. Model a crash in
    // that interval, followed by the old runtime writing the shipped baseline bytes again.
    await firstProtocol.recovery.append(ownerA, transientLegacy, 'stale-writer');
    await firstProtocol.recovery.append(ownerA, transientLegacy, 'legacy-divergence');
    legacy.set(ownerA, baseline);
    const controlBeforeRestart = await primary.read(replicaDivergenceJournalOwnerKey(ownerA));
    const resumedProtocol = protocol(primary, legacy);

    await expect(resumedProtocol.repository.prepareOwner(ownerA)).rejects.toBeInstanceOf(
      ReplicaRepositoryDivergedError,
    );
    await expect(
      resumedProtocol.repository.commit(ownerA, serialized(ownerA, 'must-remain-blocked')),
    ).rejects.toBeInstanceOf(ReplicaRepositoryDivergedError);
    expect(await primary.read(ownerA)).toBe(baseline);
    expect(await legacy.read(ownerA)).toBe(baseline);
    expect(await primary.read(replicaDivergenceJournalOwnerKey(ownerA))).toBe(controlBeforeRestart);
    expect(
      (await resumedProtocol.recovery.read(ownerA))?.snapshots.map(
        (snapshot) => snapshot.serializedReplica,
      ),
    ).toEqual([baseline, transientLegacy, transientLegacy]);
    expect(
      (await resumedProtocol.recovery.read(ownerA))?.snapshots.map((snapshot) => snapshot.reason),
    ).toEqual(['promotion-baseline', 'stale-writer', 'legacy-divergence']);
  });

  it('detects legacy drift after preparing and before the primary commit', async () => {
    const baseline = serialized(ownerA, 'baseline');
    const changedLegacy = serialized(ownerA, 'pre-commit-old-writer');
    const target = serialized(ownerA, 'target');
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const { repository } = protocol(primary, legacy);
    await repository.read(ownerA);

    primary.afterCommit = (ownerKey, raw) => {
      if (ownerKey !== replicaDivergenceJournalOwnerKey(ownerA)) return;
      const last = JSON.parse(raw).entries.at(-1);
      if (last.state === 'preparing' && last.reason === 'commit') {
        legacy.set(ownerA, changedLegacy);
      }
    };

    const error = await repository.commit(ownerA, target).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ReplicaRepositoryDivergedError);
    expect((error as ReplicaRepositoryDivergedError).primaryCommitVerified).toBe(false);
    expect(await primary.read(ownerA)).toBe(baseline);
    expect(await legacy.read(ownerA)).toBe(changedLegacy);
  });

  it('preserves a verified target when legacy drifts immediately after the primary commit', async () => {
    const baseline = serialized(ownerA, 'baseline');
    const changedLegacy = serialized(ownerA, 'post-commit-old-writer');
    const target = serialized(ownerA, 'verified-target');
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const { repository, recovery } = protocol(primary, legacy);
    await repository.read(ownerA);

    primary.afterCommit = (ownerKey) => {
      if (ownerKey === ownerA) legacy.set(ownerA, changedLegacy);
    };
    const error = await repository.commit(ownerA, target).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReplicaRepositoryDivergedError);
    expect((error as ReplicaRepositoryDivergedError).primaryCommitVerified).toBe(true);
    expect(await primary.read(ownerA)).toBe(target);
    expect(await legacy.read(ownerA)).toBe(changedLegacy);
    expect((await recovery.read(ownerA))?.snapshots.map((copy) => copy.serializedReplica)).toEqual([
      baseline,
      changedLegacy,
      target,
    ]);
  });

  it('closes a crashed normal prepare at the old root when the primary write never landed', async () => {
    const baseline = serialized(ownerA, 'baseline');
    const target = serialized(ownerA, 'target-never-landed');
    const primary = new MemoryRepo({ [ownerA]: baseline });
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const divergence = new ReplicaDivergenceJournal(primary);
    const baselineDigest = await testDigest(baseline);
    await divergence.append(ownerA, baselineDigest, {
      state: 'preparing',
      reason: 'adopt-existing',
      legacyDigest: baselineDigest,
      primaryDigest: baselineDigest,
      targetPrimaryDigest: baselineDigest,
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    });
    await divergence.append(ownerA, baselineDigest, {
      state: 'transactional',
      reason: 'adopt-existing',
      legacyDigest: baselineDigest,
      primaryDigest: baselineDigest,
      targetPrimaryDigest: null,
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    });
    await divergence.append(ownerA, baselineDigest, {
      state: 'preparing',
      reason: 'commit',
      legacyDigest: baselineDigest,
      primaryDigest: baselineDigest,
      targetPrimaryDigest: await testDigest(target),
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    });
    const recovery = new ReplicaRecoveryJournal(primary);
    const repository = new PromotingOwnerReplicaRepository(
      primary,
      legacy,
      divergence,
      recovery,
      testDigest,
    );

    expect(await repository.read(ownerA)).toBe(baseline);
    expect((await divergence.read(ownerA))?.entries.at(-1)).toMatchObject({
      state: 'transactional',
      reason: 'resume',
      primaryDigest: baselineDigest,
    });
  });

  it('finalizes a crashed prepare when the exact primary target already landed', async () => {
    const baseline = serialized(ownerA, 'baseline');
    const target = serialized(ownerA, 'target-landed');
    const primary = new MemoryRepo({ [ownerA]: baseline });
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const divergence = new ReplicaDivergenceJournal(primary);
    const baselineDigest = await testDigest(baseline);
    const targetDigest = await testDigest(target);
    await divergence.append(ownerA, baselineDigest, {
      state: 'preparing',
      reason: 'adopt-existing',
      legacyDigest: baselineDigest,
      primaryDigest: baselineDigest,
      targetPrimaryDigest: baselineDigest,
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    });
    await divergence.append(ownerA, baselineDigest, {
      state: 'transactional',
      reason: 'adopt-existing',
      legacyDigest: baselineDigest,
      primaryDigest: baselineDigest,
      targetPrimaryDigest: null,
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    });
    await divergence.append(ownerA, baselineDigest, {
      state: 'preparing',
      reason: 'commit',
      legacyDigest: baselineDigest,
      primaryDigest: baselineDigest,
      targetPrimaryDigest: targetDigest,
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    });
    primary.set(ownerA, target);
    const repository = new PromotingOwnerReplicaRepository(
      primary,
      legacy,
      divergence,
      new ReplicaRecoveryJournal(primary),
      testDigest,
    );

    expect(await repository.read(ownerA)).toBe(target);
    expect((await divergence.read(ownerA))?.entries.at(-1)).toMatchObject({
      state: 'transactional',
      reason: 'resume',
      primaryDigest: targetDigest,
    });
  });

  it('retains a preparing promotion after transient failure and retries from exact legacy bytes', async () => {
    const baseline = serialized(ownerA, 'retry-promotion');
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo({ [ownerA]: baseline });
    const { repository, divergence } = protocol(primary, legacy);
    primary.failNextCommitFor = ownerA;

    await expect(repository.read(ownerA)).rejects.toThrow('injected commit failure');
    expect((await divergence.read(ownerA))?.entries.at(-1)?.state).toBe('preparing');

    expect(await repository.read(ownerA)).toBe(baseline);
    expect(await primary.read(ownerA)).toBe(baseline);
    expect((await divergence.read(ownerA))?.entries.at(-1)).toMatchObject({
      state: 'transactional',
      reason: 'resume',
    });
  });

  it('fails closed on a malformed control journal without normalizing any durable bytes', async () => {
    const root = serialized(ownerA, 'unchanged');
    const malformed = '{"version":999,"ownerKey":"wrong"}';
    const controlKey = replicaDivergenceJournalOwnerKey(ownerA);
    const primary = new MemoryRepo({ [ownerA]: root, [controlKey]: malformed });
    const legacy = new MemoryRepo({ [ownerA]: root });
    const { repository } = protocol(primary, legacy);

    await expect(repository.read(ownerA)).rejects.toBeInstanceOf(ReplicaRepositoryAuthorityError);
    expect(await primary.read(controlKey)).toBe(malformed);
    expect(await primary.read(ownerA)).toBe(root);
    expect(await legacy.read(ownerA)).toBe(root);
    expect(await primary.read(replicaRecoveryJournalOwnerKey(ownerA))).toBeNull();
  });

  it('isolates owner journals and lets an unrelated safe owner continue', async () => {
    const a = serialized(ownerA, 'a');
    const b = serialized(ownerB, 'b');
    const bNext = serialized(ownerB, 'b-next');
    const primary = new MemoryRepo();
    const legacy = new MemoryRepo({ [ownerA]: a, [ownerB]: b });
    const { repository, divergence } = protocol(primary, legacy);
    await repository.read(ownerA);
    await repository.read(ownerB);

    legacy.set(ownerA, serialized(ownerA, 'a-old-runtime'));
    await expect(repository.verifyBeforeNetwork(ownerA)).rejects.toBeInstanceOf(
      ReplicaRepositoryDivergedError,
    );
    await expect(repository.verifyBeforeNetwork(ownerB)).resolves.toBeUndefined();
    await repository.commit(ownerB, bNext);

    expect(await primary.read(ownerA)).toBe(a);
    expect(await primary.read(ownerB)).toBe(bNext);
    expect((await divergence.read(ownerA))?.entries.at(-1)?.state).toBe('diverged');
    expect((await divergence.read(ownerB))?.entries.at(-1)?.state).toBe('transactional');
  });

  it('uses the production Expo digest implementation only behind its explicit async boundary', async () => {
    await expect(digestReplicaRoot(null)).resolves.toEqual({ kind: 'absent' });
  });
});
