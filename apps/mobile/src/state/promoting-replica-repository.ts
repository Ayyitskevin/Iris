/**
 * Mixed-version-safe authority for the default-off legacy -> transactional cutover.
 *
 * A current runtime cannot stop an already-running old runtime from writing the legacy key.
 * It can make that ambiguity explicit: exact roots remain in their source repositories or the
 * token-free recovery journal, while a digest-only write-ahead journal records the immutable
 * legacy baseline and the crash-relevant authority transition.
 */
import {
  digestReplicaRoot,
  ReplicaDivergenceJournal,
  type ReplicaDivergenceEnvelope,
  type ReplicaDivergenceReason,
  type ReplicaRootDigest,
  type ReplicaRootDigestFunction,
  sameReplicaRootDigest,
} from './replica-divergence-journal';
import {
  assertSerializedReplicaOwner,
  ReplicaRepositoryError,
  type OwnerReplicaRepository,
} from './replica-repository';
import {
  ReplicaRecoveryJournal,
  replicaRecoveryJournalOwnerKey,
  type ReplicaRecoveryReason,
} from './replica-recovery-journal';

async function eraseOwnerRoot(repository: OwnerReplicaRepository, ownerKey: string): Promise<void> {
  if (typeof repository.erase !== 'function') {
    throw new ReplicaRepositoryError(
      'Owner replica erase is unavailable on a required storage adapter',
    );
  }
  await repository.erase(ownerKey);
}

interface ReplicaRoots {
  readonly primaryRaw: string | null;
  readonly legacyRaw: string | null;
  readonly primaryDigest: ReplicaRootDigest;
  readonly legacyDigest: ReplicaRootDigest;
}

interface AuthorityObservation {
  readonly journal: ReplicaDivergenceEnvelope | null;
  readonly roots: ReplicaRoots;
}

export class ReplicaRepositoryAuthorityError extends ReplicaRepositoryError {
  readonly ownerKey: string;
  readonly primaryCommitVerified: boolean;

  constructor(
    ownerKey: string,
    message: string,
    options?: { cause?: unknown; primaryCommitVerified?: boolean },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'ReplicaRepositoryAuthorityError';
    this.ownerKey = ownerKey;
    this.primaryCommitVerified = options?.primaryCommitVerified ?? false;
  }
}

/** An absorbing, preserved split between the legacy and transactional authority roots. */
export class ReplicaRepositoryDivergedError extends ReplicaRepositoryAuthorityError {
  constructor(ownerKey: string, options?: { cause?: unknown; primaryCommitVerified?: boolean }) {
    super(ownerKey, 'Legacy and transactional owner replicas diverged', options);
    this.name = 'ReplicaRepositoryDivergedError';
  }
}

/**
 * The repository serializes the multi-key protocol per source owner. The backing transactional
 * repository still provides the independent revision fences for the primary and journal keys.
 */
export class PromotingOwnerReplicaRepository implements OwnerReplicaRepository {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    /** The durable, revision-fenced destination and journal store. */
    private readonly primary: OwnerReplicaRepository,
    /** The shipped key/value replica that an old runtime may still mutate. */
    private readonly legacy: OwnerReplicaRepository,
    private readonly divergenceJournal = new ReplicaDivergenceJournal(primary),
    private readonly recoveryJournal = new ReplicaRecoveryJournal(primary),
    private readonly digest: ReplicaRootDigestFunction = digestReplicaRoot,
  ) {}

  read(ownerKey: string): Promise<string | null> {
    return this.enqueue(
      ownerKey,
      async () => (await this.ensureAuthority(ownerKey)).roots.primaryRaw,
    );
  }

  prepareOwner(ownerKey: string): Promise<void> {
    return this.enqueue(ownerKey, async () => {
      await this.ensureAuthority(ownerKey);
    });
  }

  verifyBeforeNetwork(ownerKey: string): Promise<void> {
    return this.enqueue(ownerKey, async () => {
      await this.ensureAuthority(ownerKey);
    });
  }

  commit(ownerKey: string, serializedReplica: string): Promise<void> {
    try {
      assertSerializedReplicaOwner(ownerKey, serializedReplica);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return this.enqueue(ownerKey, () => this.commitVerified(ownerKey, serializedReplica));
  }

  /**
   * Confirmed account deletion: erase primary, legacy, and recovery-journal roots for this
   * owner. Missing erase on a child adapter fails closed rather than claiming a partial wipe.
   */
  erase(ownerKey: string): Promise<void> {
    return this.enqueue(ownerKey, async () => {
      const journalOwnerKey = replicaRecoveryJournalOwnerKey(ownerKey);
      await eraseOwnerRoot(this.primary, ownerKey);
      await eraseOwnerRoot(this.legacy, ownerKey);
      await eraseOwnerRoot(this.primary, journalOwnerKey);
    });
  }

  private enqueue<Result>(ownerKey: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.pending.get(ownerKey) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const completed = result.then(() => undefined);
    this.pending.set(ownerKey, completed);
    void completed.then(
      () => this.release(ownerKey, completed),
      () => this.release(ownerKey, completed),
    );
    return result;
  }

  private release(ownerKey: string, completed: Promise<void>): void {
    if (this.pending.get(ownerKey) === completed) this.pending.delete(ownerKey);
  }

  private authorityError(
    ownerKey: string,
    message: string,
    cause: unknown,
    primaryCommitVerified = false,
  ): ReplicaRepositoryAuthorityError {
    if (cause instanceof ReplicaRepositoryAuthorityError) return cause;
    return new ReplicaRepositoryAuthorityError(ownerKey, message, {
      cause,
      primaryCommitVerified,
    });
  }

  private async observeRoots(ownerKey: string): Promise<ReplicaRoots> {
    let primaryRaw: string | null;
    let legacyRaw: string | null;
    try {
      [primaryRaw, legacyRaw] = await Promise.all([
        this.primary.read(ownerKey),
        this.legacy.read(ownerKey),
      ]);
    } catch (cause) {
      throw this.authorityError(ownerKey, 'Owner replica roots could not be verified', cause);
    }

    try {
      const [primaryDigest, legacyDigest] = await Promise.all([
        this.digest(primaryRaw),
        this.digest(legacyRaw),
      ]);
      return Object.freeze({ primaryRaw, legacyRaw, primaryDigest, legacyDigest });
    } catch (cause) {
      throw this.authorityError(
        ownerKey,
        'Owner replica root digests could not be verified',
        cause,
      );
    }
  }

  private async readJournal(ownerKey: string): Promise<ReplicaDivergenceEnvelope | null> {
    try {
      return await this.divergenceJournal.read(ownerKey);
    } catch (cause) {
      throw this.authorityError(ownerKey, 'Replica authority journal could not be verified', cause);
    }
  }

  private async appendJournal(
    ownerKey: string,
    baseline: ReplicaRootDigest,
    transition: Parameters<ReplicaDivergenceJournal['append']>[2],
    primaryCommitVerified = false,
  ): Promise<ReplicaDivergenceEnvelope> {
    try {
      const appended = await this.divergenceJournal.append(ownerKey, baseline, transition);
      if (
        transition.state !== 'transactional' ||
        !this.divergenceJournal.requiresCompaction(appended.entries.length)
      ) {
        return appended;
      }

      // A checkpoint is a bounded transactional anchor, never a substitute for observing the two
      // source roots. Reverify both and any crash-preserved recovery evidence immediately before
      // replacing the routine commit history.
      const roots = await this.observeRoots(ownerKey);
      if (!sameReplicaRootDigest(roots.legacyDigest, baseline)) {
        return this.markDiverged(ownerKey, appended, roots, 'legacy-drift', primaryCommitVerified);
      }
      if (!sameReplicaRootDigest(roots.primaryDigest, transition.primaryDigest)) {
        return this.markDiverged(ownerKey, appended, roots, 'primary-drift', primaryCommitVerified);
      }
      await this.assertNoOrphanedDivergenceEvidence(ownerKey, appended);
      return this.divergenceJournal.compactTransactional(
        ownerKey,
        baseline,
        transition.primaryDigest,
      );
    } catch (cause) {
      throw this.authorityError(
        ownerKey,
        'Replica authority transition could not be verified',
        cause,
        primaryCommitVerified,
      );
    }
  }

  private async captureRecovery(
    ownerKey: string,
    raw: string,
    reason: ReplicaRecoveryReason,
  ): Promise<number> {
    try {
      const envelope = await this.recoveryJournal.append(ownerKey, raw, reason);
      const snapshot = envelope.snapshots.find(
        (candidate) => candidate.serializedReplica === raw && candidate.reason === reason,
      );
      if (!snapshot) {
        throw new ReplicaRepositoryError('Verified recovery copy was not returned by its journal');
      }
      return snapshot.sequence;
    } catch (cause) {
      throw this.authorityError(
        ownerKey,
        'Exact replica recovery copy could not be verified',
        cause,
      );
    }
  }

  private async assertNoOrphanedDivergenceEvidence(
    ownerKey: string,
    journal: ReplicaDivergenceEnvelope,
  ): Promise<void> {
    let recovery;
    try {
      recovery = await this.recoveryJournal.read(ownerKey);
    } catch (cause) {
      throw this.authorityError(
        ownerKey,
        'Replica divergence recovery evidence could not be verified',
        cause,
      );
    }
    if (!recovery) return;

    const referenced = new Set<number>();
    for (const entry of journal.entries) {
      if (entry.legacyRecoverySequence !== null) referenced.add(entry.legacyRecoverySequence);
      if (entry.primaryRecoverySequence !== null) referenced.add(entry.primaryRecoverySequence);
    }
    const orphaned = recovery.snapshots.some(
      (snapshot) =>
        (snapshot.reason === 'legacy-divergence' || snapshot.reason === 'primary-divergence') &&
        !referenced.has(snapshot.sequence),
    );
    if (orphaned) throw new ReplicaRepositoryDivergedError(ownerKey);
  }

  private preparingTransition(
    roots: ReplicaRoots,
    targetPrimaryDigest: ReplicaRootDigest,
    reason: Extract<ReplicaDivergenceReason, 'promotion' | 'commit' | 'adopt-existing'>,
  ): Parameters<ReplicaDivergenceJournal['append']>[2] {
    return {
      state: 'preparing',
      reason,
      legacyDigest: roots.legacyDigest,
      primaryDigest: roots.primaryDigest,
      targetPrimaryDigest,
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    };
  }

  private transactionalTransition(
    baseline: ReplicaRootDigest,
    primaryDigest: ReplicaRootDigest,
    reason: Extract<ReplicaDivergenceReason, 'promotion' | 'commit' | 'adopt-existing' | 'resume'>,
  ): Parameters<ReplicaDivergenceJournal['append']>[2] {
    return {
      state: 'transactional',
      reason,
      legacyDigest: baseline,
      primaryDigest,
      targetPrimaryDigest: null,
      legacyRecoverySequence: null,
      primaryRecoverySequence: null,
    };
  }

  private async ensureAuthority(ownerKey: string): Promise<AuthorityObservation> {
    const journal = await this.readJournal(ownerKey);
    const roots = await this.observeRoots(ownerKey);
    if (!journal) return this.initializeAuthority(ownerKey, roots);

    const last = journal.entries[journal.entries.length - 1]!;
    if (last.state === 'diverged') {
      // Divergence remains absorbing, but a still-running old runtime may advance either exact
      // branch after the first detection. Preserve every newly observed root before failing
      // closed again; writing the legacy bytes back to the known baseline needs no duplicate.
      if (
        !sameReplicaRootDigest(roots.legacyDigest, last.legacyDigest) &&
        !sameReplicaRootDigest(roots.legacyDigest, journal.legacyBaselineDigest)
      ) {
        return this.markDiverged(ownerKey, journal, roots, 'legacy-drift');
      }
      if (!sameReplicaRootDigest(roots.primaryDigest, last.primaryDigest)) {
        return this.markDiverged(ownerKey, journal, roots, 'primary-drift');
      }
      throw new ReplicaRepositoryDivergedError(ownerKey);
    }

    if (!sameReplicaRootDigest(roots.legacyDigest, journal.legacyBaselineDigest)) {
      return this.markDiverged(ownerKey, journal, roots, 'legacy-drift');
    }
    if (last.state === 'preparing') {
      return this.resumePreparing(ownerKey, journal, roots);
    }
    if (!sameReplicaRootDigest(roots.primaryDigest, last.primaryDigest)) {
      return this.markDiverged(ownerKey, journal, roots, 'primary-drift');
    }
    await this.assertNoOrphanedDivergenceEvidence(ownerKey, journal);
    return Object.freeze({ journal, roots });
  }

  private async initializeAuthority(
    ownerKey: string,
    roots: ReplicaRoots,
  ): Promise<AuthorityObservation> {
    if (roots.primaryRaw === null && roots.legacyRaw === null) {
      return Object.freeze({ journal: null, roots });
    }

    const baseline = roots.legacyDigest;
    if (roots.legacyRaw !== null) {
      await this.captureRecovery(ownerKey, roots.legacyRaw, 'promotion-baseline');
    }

    if (roots.primaryRaw === null && roots.legacyRaw !== null) {
      const preparing = await this.appendJournal(
        ownerKey,
        baseline,
        this.preparingTransition(roots, roots.legacyDigest, 'promotion'),
      );
      return this.completePreparedWrite(ownerKey, preparing, roots.legacyRaw, true, 'promotion');
    }

    const preparing = await this.appendJournal(
      ownerKey,
      baseline,
      this.preparingTransition(roots, roots.primaryDigest, 'adopt-existing'),
    );
    const observed = await this.observeRoots(ownerKey);
    if (!sameReplicaRootDigest(observed.legacyDigest, baseline)) {
      return this.markDiverged(ownerKey, preparing, observed, 'legacy-drift');
    }
    if (!sameReplicaRootDigest(observed.primaryDigest, roots.primaryDigest)) {
      return this.markDiverged(ownerKey, preparing, observed, 'primary-drift');
    }
    if (
      observed.legacyRaw !== null &&
      !sameReplicaRootDigest(observed.legacyDigest, observed.primaryDigest)
    ) {
      return this.markDiverged(ownerKey, preparing, observed, 'primary-drift');
    }
    const transactional = await this.appendJournal(
      ownerKey,
      baseline,
      this.transactionalTransition(baseline, observed.primaryDigest, 'adopt-existing'),
    );
    return Object.freeze({ journal: transactional, roots: observed });
  }

  private async resumePreparing(
    ownerKey: string,
    journal: ReplicaDivergenceEnvelope,
    roots: ReplicaRoots,
  ): Promise<AuthorityObservation> {
    const preparing = journal.entries[journal.entries.length - 1]!;
    const target = preparing.targetPrimaryDigest!;

    if (sameReplicaRootDigest(roots.primaryDigest, target)) {
      if (
        preparing.reason === 'adopt-existing' &&
        roots.legacyRaw !== null &&
        !sameReplicaRootDigest(roots.legacyDigest, roots.primaryDigest)
      ) {
        return this.markDiverged(ownerKey, journal, roots, 'primary-drift');
      }
      await this.assertNoOrphanedDivergenceEvidence(ownerKey, journal);
      const transactional = await this.appendJournal(
        ownerKey,
        journal.legacyBaselineDigest,
        this.transactionalTransition(journal.legacyBaselineDigest, roots.primaryDigest, 'resume'),
        true,
      );
      return Object.freeze({ journal: transactional, roots });
    }

    if (!sameReplicaRootDigest(roots.primaryDigest, preparing.primaryDigest)) {
      return this.markDiverged(ownerKey, journal, roots, 'primary-drift');
    }

    await this.assertNoOrphanedDivergenceEvidence(ownerKey, journal);

    if (
      preparing.reason === 'promotion' &&
      roots.legacyRaw !== null &&
      sameReplicaRootDigest(roots.legacyDigest, target)
    ) {
      return this.completePreparedWrite(ownerKey, journal, roots.legacyRaw, true, 'resume');
    }

    const transactional = await this.appendJournal(
      ownerKey,
      journal.legacyBaselineDigest,
      this.transactionalTransition(journal.legacyBaselineDigest, roots.primaryDigest, 'resume'),
    );
    return Object.freeze({ journal: transactional, roots });
  }

  private async commitVerified(ownerKey: string, serializedReplica: string): Promise<void> {
    const authority = await this.ensureAuthority(ownerKey);
    const target = await this.digest(serializedReplica);
    if (target.kind !== 'sha256') {
      throw new ReplicaRepositoryError('A committed owner replica cannot have an absent digest');
    }
    if (sameReplicaRootDigest(authority.roots.primaryDigest, target)) return;

    const baseline = authority.journal?.legacyBaselineDigest ?? authority.roots.legacyDigest;
    const preparing = await this.appendJournal(
      ownerKey,
      baseline,
      this.preparingTransition(authority.roots, target, 'commit'),
    );
    await this.completePreparedWrite(ownerKey, preparing, serializedReplica, false, 'commit');
  }

  private async completePreparedWrite(
    ownerKey: string,
    journal: ReplicaDivergenceEnvelope,
    targetRaw: string,
    retryFromLegacyOnFailure: boolean,
    completedReason: Extract<ReplicaDivergenceReason, 'promotion' | 'commit' | 'resume'>,
  ): Promise<AuthorityObservation> {
    const preparing = journal.entries[journal.entries.length - 1]!;
    const target = preparing.targetPrimaryDigest!;
    const baseline = journal.legacyBaselineDigest;
    let roots = await this.observeRoots(ownerKey);

    if (!sameReplicaRootDigest(roots.legacyDigest, baseline)) {
      return this.markDiverged(ownerKey, journal, roots, 'legacy-drift');
    }
    if (sameReplicaRootDigest(roots.primaryDigest, target)) {
      const transactional = await this.appendJournal(
        ownerKey,
        baseline,
        this.transactionalTransition(baseline, roots.primaryDigest, completedReason),
        true,
      );
      return Object.freeze({ journal: transactional, roots });
    }
    if (!sameReplicaRootDigest(roots.primaryDigest, preparing.primaryDigest)) {
      return this.markDiverged(ownerKey, journal, roots, 'primary-drift');
    }

    let commitError: unknown;
    try {
      await this.primary.commit(ownerKey, targetRaw);
    } catch (cause) {
      commitError = cause;
    }

    try {
      roots = await this.observeRoots(ownerKey);
    } catch (cause) {
      throw this.authorityError(
        ownerKey,
        'Primary owner replica commit outcome could not be verified',
        commitError ?? cause,
      );
    }
    if (!sameReplicaRootDigest(roots.legacyDigest, baseline)) {
      return this.markDiverged(
        ownerKey,
        journal,
        roots,
        'legacy-drift',
        sameReplicaRootDigest(roots.primaryDigest, target),
      );
    }
    if (sameReplicaRootDigest(roots.primaryDigest, target)) {
      const transactional = await this.appendJournal(
        ownerKey,
        baseline,
        this.transactionalTransition(baseline, roots.primaryDigest, completedReason),
        true,
      );
      return Object.freeze({ journal: transactional, roots });
    }
    if (!sameReplicaRootDigest(roots.primaryDigest, preparing.primaryDigest)) {
      return this.markDiverged(ownerKey, journal, roots, 'primary-drift');
    }
    if (commitError) {
      if (!retryFromLegacyOnFailure) {
        await this.appendJournal(
          ownerKey,
          baseline,
          this.transactionalTransition(baseline, roots.primaryDigest, 'resume'),
        );
      }
      throw commitError;
    }
    throw this.authorityError(
      ownerKey,
      'Primary owner replica commit did not reach durable storage',
      undefined,
    );
  }

  private async markDiverged(
    ownerKey: string,
    journal: ReplicaDivergenceEnvelope,
    roots: ReplicaRoots,
    reason: Extract<ReplicaDivergenceReason, 'legacy-drift' | 'primary-drift'>,
    primaryCommitVerified = false,
  ): Promise<never> {
    const legacyRecoverySequence =
      roots.legacyRaw === null
        ? null
        : await this.captureRecovery(ownerKey, roots.legacyRaw, 'legacy-divergence');
    const primaryRecoverySequence =
      roots.primaryRaw === null
        ? null
        : await this.captureRecovery(ownerKey, roots.primaryRaw, 'primary-divergence');

    await this.appendJournal(
      ownerKey,
      journal.legacyBaselineDigest,
      {
        state: 'diverged',
        reason,
        legacyDigest: roots.legacyDigest,
        primaryDigest: roots.primaryDigest,
        targetPrimaryDigest: null,
        legacyRecoverySequence,
        primaryRecoverySequence,
      },
      primaryCommitVerified,
    );
    throw new ReplicaRepositoryDivergedError(ownerKey, { primaryCommitVerified });
  }
}
