import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const expoCrypto = vi.hoisted(() => ({
  digestStringAsync: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: expoCrypto.digestStringAsync,
}));

import { assertSerializedReplicaOwner, type OwnerReplicaRepository } from './replica-repository';
import {
  digestReplicaRoot,
  parseReplicaDivergenceEnvelope,
  REPLICA_ROOT_DIGEST_DOMAIN,
  ReplicaDivergenceJournal,
  ReplicaDivergenceJournalError,
  replicaDivergenceJournalOwnerKey,
  type ReplicaDivergenceTransition,
  type ReplicaRootDigest,
} from './replica-divergence-journal';
import { ReplicaRepositoryStaleWriterError } from './transactional-replica-repository';

const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.11111111-1111-4111-8111-111111111111';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.22222222-2222-4222-8222-222222222222';
const OBSERVED_AT = '2026-07-19T12:00:00.000Z';
const ABSENT = Object.freeze({ kind: 'absent' } as const);

function replica(ownerKey: string, label: string): string {
  const [workspaceId, userId] = ownerKey.split('.');
  return JSON.stringify({
    version: 2,
    ownerKey,
    userId,
    workspaceId,
    notes: {},
    syncCursor: label,
    deviceId: 'device-test',
    outbox: [],
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
  });
}

class StrictMemoryOwnerRepository implements OwnerReplicaRepository {
  readonly values = new Map<string, string>();
  commits = 0;
  reads = 0;
  staleCommitsRemaining = 0;
  replacementOnStaleCommit: string | null = null;

  async read(ownerKey: string): Promise<string | null> {
    this.reads += 1;
    return this.values.get(ownerKey) ?? null;
  }

  async commit(ownerKey: string, serializedReplica: string): Promise<void> {
    assertSerializedReplicaOwner(ownerKey, serializedReplica);
    this.commits += 1;
    if (this.staleCommitsRemaining > 0) {
      this.staleCommitsRemaining -= 1;
      if (this.replacementOnStaleCommit !== null) {
        this.values.set(ownerKey, this.replacementOnStaleCommit);
        this.replacementOnStaleCommit = null;
      }
      throw new ReplicaRepositoryStaleWriterError(ownerKey);
    }
    this.values.set(ownerKey, serializedReplica);
  }
}

function preparing(
  legacyDigest: ReplicaRootDigest,
  primaryDigest: ReplicaRootDigest,
  targetPrimaryDigest: ReplicaRootDigest,
  reason: 'promotion' | 'commit' | 'adopt-existing' = 'promotion',
): ReplicaDivergenceTransition {
  return {
    state: 'preparing',
    reason,
    legacyDigest,
    primaryDigest,
    targetPrimaryDigest,
    legacyRecoverySequence: null,
    primaryRecoverySequence: null,
  };
}

function transactional(
  legacyDigest: ReplicaRootDigest,
  primaryDigest: ReplicaRootDigest,
  reason: 'promotion' | 'commit' | 'adopt-existing' | 'resume' | 'checkpoint' = 'promotion',
): ReplicaDivergenceTransition {
  return {
    state: 'transactional',
    reason,
    legacyDigest,
    primaryDigest,
    targetPrimaryDigest: null,
    legacyRecoverySequence: null,
    primaryRecoverySequence: null,
  };
}

function diverged(
  legacyDigest: ReplicaRootDigest,
  primaryDigest: ReplicaRootDigest,
  reason: 'legacy-drift' | 'primary-drift',
): ReplicaDivergenceTransition {
  return {
    state: 'diverged',
    reason,
    legacyDigest,
    primaryDigest,
    targetPrimaryDigest: null,
    legacyRecoverySequence: legacyDigest.kind === 'absent' ? null : 1,
    primaryRecoverySequence: primaryDigest.kind === 'absent' ? null : 2,
  };
}

async function durablePreparingEnvelope(
  repository: StrictMemoryOwnerRepository,
  sourceOwnerKey = OWNER_A,
) {
  const journal = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT);
  const legacy = await digestReplicaRoot(replica(sourceOwnerKey, 'legacy-private-sentinel'));
  await journal.append(sourceOwnerKey, legacy, preparing(legacy, ABSENT, legacy));
  const key = replicaDivergenceJournalOwnerKey(sourceOwnerKey);
  return { journal, key, legacy, raw: repository.values.get(key)! };
}

beforeEach(() => {
  expoCrypto.digestStringAsync.mockReset();
  expoCrypto.digestStringAsync.mockImplementation(
    async (_algorithm: string, value: string, _options: { encoding: string }) =>
      createHash('sha256').update(value, 'utf8').digest('hex'),
  );
});

describe('digestReplicaRoot', () => {
  it('hashes exact UTF-8 bytes with the immutable domain and NUL separator', async () => {
    const serialized = replica(OWNER_A, 'private-sentinel');
    const expected = createHash('sha256')
      .update(REPLICA_ROOT_DIGEST_DOMAIN + '\u0000' + serialized, 'utf8')
      .digest('hex');
    const undomained = createHash('sha256').update(serialized, 'utf8').digest('hex');

    await expect(digestReplicaRoot(serialized)).resolves.toEqual({
      kind: 'sha256',
      algorithm: 'SHA-256',
      domain: REPLICA_ROOT_DIGEST_DOMAIN,
      hex: expected,
    });
    expect(expected).not.toBe(undomained);
    expect(expoCrypto.digestStringAsync).toHaveBeenCalledOnce();
    expect(expoCrypto.digestStringAsync).toHaveBeenCalledWith(
      'SHA-256',
      REPLICA_ROOT_DIGEST_DOMAIN + '\u0000' + serialized,
      { encoding: 'hex' },
    );
    await expect(digestReplicaRoot(null)).resolves.toEqual({ kind: 'absent' });
    expect(expoCrypto.digestStringAsync).toHaveBeenCalledOnce();
  });

  it('rejects a digest adapter that returns non-canonical SHA-256 data', async () => {
    expoCrypto.digestStringAsync.mockResolvedValueOnce('ABCDEF');

    await expect(digestReplicaRoot(replica(OWNER_A, 'invalid-digest'))).rejects.toBeInstanceOf(
      ReplicaDivergenceJournalError,
    );
  });
});

describe('ReplicaDivergenceJournal parsing and ownership', () => {
  it('stores only digests under an owner-isolated synthetic key', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const first = await durablePreparingEnvelope(repository, OWNER_A);
    const second = await durablePreparingEnvelope(repository, OWNER_B);

    expect(first.key).not.toBe(second.key);
    expect(first.key).toBe(replicaDivergenceJournalOwnerKey(OWNER_A));
    expect(second.key).toBe(replicaDivergenceJournalOwnerKey(OWNER_B));
    expect(repository.values.size).toBe(2);
    expect(first.raw).not.toContain('legacy-private-sentinel');
    expect(second.raw).not.toContain('legacy-private-sentinel');
    expect((await first.journal.read(OWNER_A))?.sourceOwnerKey).toBe(OWNER_A);
    expect((await second.journal.read(OWNER_B))?.sourceOwnerKey).toBe(OWNER_B);
    expect(() => parseReplicaDivergenceEnvelope(first.raw, OWNER_B)).toThrow(
      ReplicaDivergenceJournalError,
    );
  });

  it('rejects unknown fields and non-contiguous entry metadata', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const { raw } = await durablePreparingEnvelope(repository);

    const envelopeWithExtra = JSON.parse(raw) as Record<string, unknown>;
    envelopeWithExtra.unexpected = true;
    expect(() =>
      parseReplicaDivergenceEnvelope(JSON.stringify(envelopeWithExtra), OWNER_A),
    ).toThrow(ReplicaDivergenceJournalError);

    const entryWithExtra = JSON.parse(raw) as Record<string, unknown>;
    const extraEntries = entryWithExtra.entries as Record<string, unknown>[];
    extraEntries[0] = { ...extraEntries[0], unexpected: true };
    expect(() => parseReplicaDivergenceEnvelope(JSON.stringify(entryWithExtra), OWNER_A)).toThrow(
      ReplicaDivergenceJournalError,
    );

    const digestWithExtra = JSON.parse(raw) as Record<string, unknown>;
    const digestEntries = digestWithExtra.entries as Record<string, unknown>[];
    digestEntries[0]!.legacyDigest = {
      ...(digestEntries[0]!.legacyDigest as Record<string, unknown>),
      unexpected: true,
    };
    expect(() => parseReplicaDivergenceEnvelope(JSON.stringify(digestWithExtra), OWNER_A)).toThrow(
      ReplicaDivergenceJournalError,
    );

    const nonContiguous = JSON.parse(raw) as Record<string, unknown>;
    const nonContiguousEntries = nonContiguous.entries as Record<string, unknown>[];
    nonContiguousEntries[0]!.sequence = 2;
    expect(() => parseReplicaDivergenceEnvelope(JSON.stringify(nonContiguous), OWNER_A)).toThrow(
      ReplicaDivergenceJournalError,
    );
  });

  it('fails closed without rewriting malformed or future-version durable records', async () => {
    const source = new StrictMemoryOwnerRepository();
    const { raw, key, legacy } = await durablePreparingEnvelope(source);
    const malformed = '{not-json';
    const futureValue = JSON.parse(raw) as Record<string, unknown>;
    futureValue.version = 2;

    for (const seeded of [malformed, JSON.stringify(futureValue)]) {
      const repository = new StrictMemoryOwnerRepository();
      repository.values.set(key, seeded);
      const journal = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT);

      await expect(journal.read(OWNER_A)).rejects.toBeInstanceOf(ReplicaDivergenceJournalError);
      await expect(
        journal.append(OWNER_A, legacy, transactional(legacy, legacy)),
      ).rejects.toBeInstanceOf(ReplicaDivergenceJournalError);
      expect(repository.values.get(key)).toBe(seeded);
      expect(repository.commits).toBe(0);
    }
  });
});

describe('ReplicaDivergenceJournal transitions', () => {
  it('requires preparing first, then accepts only legal contiguous transitions', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const journal = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT);
    const legacy = await digestReplicaRoot(replica(OWNER_A, 'legacy'));
    const promoted = legacy;
    const nextPrimary = await digestReplicaRoot(replica(OWNER_A, 'next-primary'));
    const unexpectedPrimary = await digestReplicaRoot(replica(OWNER_A, 'unexpected-primary'));

    await expect(journal.append(OWNER_A, legacy, transactional(legacy, promoted))).rejects.toThrow(
      'must begin preparing',
    );
    expect(repository.commits).toBe(0);

    await journal.append(OWNER_A, legacy, preparing(legacy, ABSENT, promoted));
    await expect(
      journal.append(OWNER_A, legacy, preparing(legacy, ABSENT, promoted)),
    ).resolves.toMatchObject({ entries: [{ state: 'preparing' }] });
    expect(repository.commits).toBe(1);

    await journal.append(OWNER_A, legacy, transactional(legacy, promoted));
    await journal.append(OWNER_A, legacy, preparing(legacy, promoted, nextPrimary, 'commit'));
    const envelope = await journal.append(
      OWNER_A,
      legacy,
      diverged(legacy, unexpectedPrimary, 'primary-drift'),
    );

    expect(
      envelope.entries.map(({ sequence, state, reason }) => ({ sequence, state, reason })),
    ).toEqual([
      { sequence: 1, state: 'preparing', reason: 'promotion' },
      { sequence: 2, state: 'transactional', reason: 'promotion' },
      { sequence: 3, state: 'preparing', reason: 'commit' },
      { sequence: 4, state: 'diverged', reason: 'primary-drift' },
    ]);
    expect(
      parseReplicaDivergenceEnvelope(
        repository.values.get(replicaDivergenceJournalOwnerKey(OWNER_A))!,
        OWNER_A,
      ),
    ).toEqual(envelope);
  });

  it('keeps legacy baseline immutable', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const { journal, legacy } = await durablePreparingEnvelope(repository);
    const changedLegacy = await digestReplicaRoot(replica(OWNER_A, 'changed-legacy'));

    await expect(
      journal.append(OWNER_A, changedLegacy, transactional(changedLegacy, legacy)),
    ).rejects.toThrow('Legacy baseline digest is immutable');
    expect(repository.commits).toBe(1);
  });

  it('rejects shape-valid transitions that disconnect the primary lineage', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const journal = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT);
    const legacy = await digestReplicaRoot(replica(OWNER_A, 'legacy'));
    const unrelated = await digestReplicaRoot(replica(OWNER_A, 'unrelated'));
    const target = await digestReplicaRoot(replica(OWNER_A, 'target'));

    await journal.append(OWNER_A, legacy, preparing(legacy, ABSENT, legacy));
    await expect(journal.append(OWNER_A, legacy, transactional(legacy, unrelated))).rejects.toThrow(
      'does not resolve',
    );
    await journal.append(OWNER_A, legacy, transactional(legacy, legacy));
    await expect(
      journal.append(OWNER_A, legacy, preparing(legacy, unrelated, target, 'commit')),
    ).rejects.toThrow('does not continue');

    expect((await journal.read(OWNER_A))?.entries).toHaveLength(2);
  });

  it('makes diverged absorbing while allowing further divergence evidence', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const { journal, legacy } = await durablePreparingEnvelope(repository);
    const changedLegacy = await digestReplicaRoot(replica(OWNER_A, 'legacy-drift'));
    await journal.append(OWNER_A, legacy, diverged(changedLegacy, legacy, 'legacy-drift'));

    await expect(
      journal.append(OWNER_A, legacy, transactional(legacy, legacy, 'resume')),
    ).rejects.toThrow('absorbing');

    const laterPrimary = await digestReplicaRoot(replica(OWNER_A, 'later-primary'));
    const envelope = await journal.append(
      OWNER_A,
      legacy,
      diverged(changedLegacy, laterPrimary, 'primary-drift'),
    );
    expect(envelope.entries.map((entry) => entry.state)).toEqual([
      'preparing',
      'diverged',
      'diverged',
    ]);
  });

  it('retries stale-CAS conflicts and deduplicates an identical transition', async () => {
    const repository = new StrictMemoryOwnerRepository();
    repository.staleCommitsRemaining = 1;
    const journal = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT);
    const legacy = await digestReplicaRoot(replica(OWNER_A, 'legacy'));
    const transition = preparing(legacy, ABSENT, legacy);

    const first = await journal.append(OWNER_A, legacy, transition);
    expect(first.entries).toHaveLength(1);
    expect(repository.commits).toBe(2);
    expect(repository.reads).toBeGreaterThanOrEqual(2);

    const repeated = await journal.append(OWNER_A, legacy, transition);
    expect(repeated).toEqual(first);
    expect(repository.commits).toBe(2);
  });

  it('deduplicates semantic digest identity independent of object key insertion order', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const journal = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT);
    const legacy = await digestReplicaRoot(replica(OWNER_A, 'legacy'));
    if (legacy.kind !== 'sha256') throw new Error('Expected a present digest');
    const reorderedLegacy: ReplicaRootDigest = {
      hex: legacy.hex,
      domain: legacy.domain,
      algorithm: legacy.algorithm,
      kind: legacy.kind,
    };

    const first = await journal.append(OWNER_A, legacy, preparing(legacy, ABSENT, legacy));
    const repeated = await journal.append(
      OWNER_A,
      reorderedLegacy,
      preparing(reorderedLegacy, ABSENT, reorderedLegacy),
    );

    expect(repeated).toEqual(first);
    expect(repository.commits).toBe(1);
  });

  it('bounds verified transactional history with a restartable checkpoint', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const journal = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT, 8, 3);
    const legacy = await digestReplicaRoot(replica(OWNER_A, 'legacy'));
    const nextPrimary = await digestReplicaRoot(replica(OWNER_A, 'next-primary'));
    const laterPrimary = await digestReplicaRoot(replica(OWNER_A, 'later-primary'));

    await journal.append(OWNER_A, legacy, preparing(legacy, ABSENT, legacy));
    await journal.append(OWNER_A, legacy, transactional(legacy, legacy));
    await journal.append(OWNER_A, legacy, preparing(legacy, legacy, nextPrimary, 'commit'));
    await journal.append(OWNER_A, legacy, transactional(legacy, nextPrimary, 'commit'));
    const checkpoint = await journal.compactTransactional(OWNER_A, legacy, nextPrimary);

    expect(checkpoint.entries).toEqual([
      expect.objectContaining({
        sequence: 1,
        state: 'transactional',
        reason: 'checkpoint',
        legacyDigest: legacy,
        primaryDigest: nextPrimary,
      }),
    ]);
    const restarted = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT, 8, 3);
    await restarted.append(OWNER_A, legacy, preparing(legacy, nextPrimary, laterPrimary, 'commit'));
    const resumed = await restarted.append(
      OWNER_A,
      legacy,
      transactional(legacy, laterPrimary, 'commit'),
    );
    expect(resumed.entries.map((entry) => entry.state)).toEqual([
      'transactional',
      'preparing',
      'transactional',
    ]);
  });

  it('leaves the full verified envelope intact when checkpoint replacement fails', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const journal = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT, 1, 3);
    const legacy = await digestReplicaRoot(replica(OWNER_A, 'legacy'));
    const nextPrimary = await digestReplicaRoot(replica(OWNER_A, 'next-primary'));
    await journal.append(OWNER_A, legacy, preparing(legacy, ABSENT, legacy));
    await journal.append(OWNER_A, legacy, transactional(legacy, legacy));
    await journal.append(OWNER_A, legacy, preparing(legacy, legacy, nextPrimary, 'commit'));
    await journal.append(OWNER_A, legacy, transactional(legacy, nextPrimary, 'commit'));
    const ownerKey = replicaDivergenceJournalOwnerKey(OWNER_A);
    const fullHistory = repository.values.get(ownerKey)!;
    repository.staleCommitsRemaining = 1;

    await expect(journal.compactTransactional(OWNER_A, legacy, nextPrimary)).rejects.toBeInstanceOf(
      ReplicaDivergenceJournalError,
    );
    expect(repository.values.get(ownerKey)).toBe(fullHistory);
    expect(parseReplicaDivergenceEnvelope(fullHistory, OWNER_A).entries).toHaveLength(4);
  });

  it('never truncates a preparing writer discovered during checkpoint CAS retry', async () => {
    const repository = new StrictMemoryOwnerRepository();
    const journal = new ReplicaDivergenceJournal(repository, () => OBSERVED_AT, 2, 3);
    const legacy = await digestReplicaRoot(replica(OWNER_A, 'legacy'));
    const nextPrimary = await digestReplicaRoot(replica(OWNER_A, 'next-primary'));
    const competingTarget = await digestReplicaRoot(replica(OWNER_A, 'competing-target'));
    await journal.append(OWNER_A, legacy, preparing(legacy, ABSENT, legacy));
    await journal.append(OWNER_A, legacy, transactional(legacy, legacy));
    await journal.append(OWNER_A, legacy, preparing(legacy, legacy, nextPrimary, 'commit'));
    await journal.append(OWNER_A, legacy, transactional(legacy, nextPrimary, 'commit'));
    const ownerKey = replicaDivergenceJournalOwnerKey(OWNER_A);
    const competing = JSON.parse(repository.values.get(ownerKey)!) as {
      entries: Array<Record<string, unknown>>;
    };
    competing.entries.push({
      sequence: 5,
      observedAt: OBSERVED_AT,
      state: 'preparing',
      reason: 'commit',
      legacyDigest: legacy,
      primaryDigest: nextPrimary,
      targetPrimaryDigest: competingTarget,
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    });
    const competingRaw = JSON.stringify(competing);
    expect(parseReplicaDivergenceEnvelope(competingRaw, OWNER_A).entries.at(-1)?.state).toBe(
      'preparing',
    );
    repository.staleCommitsRemaining = 1;
    repository.replacementOnStaleCommit = competingRaw;

    await expect(journal.compactTransactional(OWNER_A, legacy, nextPrimary)).rejects.toThrow(
      'does not match verified authority',
    );
    expect(repository.values.get(ownerKey)).toBe(competingRaw);
  });
});
