import {
  assertReplicaRecoverySnapshot,
  parseReplicaRecoveryEnvelope,
  type ReplicaRecoveryEnvelope,
  type ReplicaRecoveryReason,
} from './replica-recovery-journal';

const NOTE_PREVIEW_LIMIT = 5;
const TITLE_PREVIEW_LIMIT = 120;
const BODY_PREVIEW_LIMIT = 160;

interface RecoveryReplicaNote {
  id: string;
  title: string;
  bodyMd: string;
  deletedAt: string | null;
}

interface RecoveryReplicaShape {
  notes: Record<string, RecoveryReplicaNote>;
  outbox: unknown[];
  pendingPush: unknown[] | null;
  syncIssue: unknown | null;
  conflicts: Record<string, unknown>;
}

export interface PendingReplicaRecovery {
  serializedReplica: string;
  reason: ReplicaRecoveryReason;
}

export type ReplicaRecoveryPersistence = 'journal-verified' | 'memory-only' | 'displayed-only';

export interface ReplicaRecoveryNotePreview {
  id: string;
  title: string;
  body: string;
  deleted: boolean;
}

export interface ReplicaRecoveryCatalogCopy {
  key: string;
  persistence: ReplicaRecoveryPersistence;
  sequence: number | null;
  capturedAt: string | null;
  reason: ReplicaRecoveryReason | null;
  matchesDisplayedProjection: boolean;
  liveNoteCount: number;
  deletedNoteCount: number;
  outboxCount: number;
  pendingPushCount: number;
  conflictCount: number;
  hasSyncIssue: boolean;
  notePreviews: ReplicaRecoveryNotePreview[];
  omittedNotePreviewCount: number;
}

export interface ReplicaRecoveryCatalog {
  sourceOwnerKey: string;
  inventoryComplete: boolean;
  preservedCount: number;
  journalVerifiedCount: number;
  memoryOnlyCount: number;
  hasUnverifiedCopies: boolean;
  copies: ReplicaRecoveryCatalogCopy[];
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit - 1) + '…';
}

function bodyPreview(value: string): string {
  return bounded(value.replace(/\s+/g, ' ').trim(), BODY_PREVIEW_LIMIT);
}

function provenancePriority(reason: ReplicaRecoveryReason): number {
  return reason === 'legacy-divergence' || reason === 'primary-divergence' ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalValue(record[key])]),
  );
}

export function canonicalReplica(serializedReplica: string): string {
  return JSON.stringify(canonicalValue(JSON.parse(serializedReplica) as unknown));
}

function summarizeCopy(
  sourceOwnerKey: string,
  copy: Pick<
    ReplicaRecoveryCatalogCopy,
    'key' | 'persistence' | 'sequence' | 'capturedAt' | 'reason'
  > & { serializedReplica: string },
  displayedCanonical: string,
): ReplicaRecoveryCatalogCopy {
  const { serializedReplica, ...summary } = copy;
  assertReplicaRecoverySnapshot(sourceOwnerKey, serializedReplica);
  const replica = JSON.parse(serializedReplica) as RecoveryReplicaShape;
  const notes = Object.values(replica.notes).sort((left, right) => left.id.localeCompare(right.id));
  const notePreviews = notes.slice(0, NOTE_PREVIEW_LIMIT).map((note) =>
    Object.freeze({
      id: note.id,
      title: bounded(note.title, TITLE_PREVIEW_LIMIT),
      body: bodyPreview(note.bodyMd),
      deleted: note.deletedAt !== null,
    }),
  );

  return Object.freeze({
    ...summary,
    matchesDisplayedProjection: canonicalReplica(serializedReplica) === displayedCanonical,
    liveNoteCount: notes.filter((note) => note.deletedAt === null).length,
    deletedNoteCount: notes.filter((note) => note.deletedAt !== null).length,
    outboxCount: replica.outbox.length,
    pendingPushCount: replica.pendingPush?.length ?? 0,
    conflictCount: Object.keys(replica.conflicts).length,
    hasSyncIssue: replica.syncIssue !== null,
    notePreviews: Object.freeze(notePreviews),
    omittedNotePreviewCount: Math.max(0, notes.length - notePreviews.length),
  }) as ReplicaRecoveryCatalogCopy;
}

/**
 * Compose an owner-local, read-only inventory without assigning semantic recency.
 *
 * Journal sequence describes capture order only. Memory-only candidates have no invented
 * timestamp or sequence. Distinct reason records for the same exact bytes collapse to one card,
 * retaining divergence provenance over generic capture reasons and otherwise the latest capture
 * metadata. That does not treat the root itself as semantically newer. Structurally identical but
 * byte-distinct roots may all match the displayed projection; neither fact means preferred or
 * more complete.
 */
export function buildReplicaRecoveryCatalog(input: {
  sourceOwnerKey: string;
  envelope: ReplicaRecoveryEnvelope | null;
  pending: readonly PendingReplicaRecovery[];
  displayedSerializedReplica: string;
  inventoryComplete?: boolean;
}): ReplicaRecoveryCatalog | null {
  const { sourceOwnerKey, pending, displayedSerializedReplica } = input;
  if (!input.envelope && pending.length === 0) return null;

  const envelope = input.envelope
    ? parseReplicaRecoveryEnvelope(JSON.stringify(input.envelope), sourceOwnerKey)
    : null;
  assertReplicaRecoverySnapshot(sourceOwnerKey, displayedSerializedReplica);
  const displayedCanonical = canonicalReplica(displayedSerializedReplica);
  const exactRoots = new Set<string>();
  const copies: ReplicaRecoveryCatalogCopy[] = [];
  const latestSnapshotByRoot = new Map<string, ReplicaRecoveryEnvelope['snapshots'][number]>();

  for (const snapshot of envelope?.snapshots ?? []) {
    const selected = latestSnapshotByRoot.get(snapshot.serializedReplica);
    if (!selected || provenancePriority(snapshot.reason) >= provenancePriority(selected.reason)) {
      latestSnapshotByRoot.set(snapshot.serializedReplica, snapshot);
    }
  }

  for (const snapshot of envelope?.snapshots ?? []) {
    if (latestSnapshotByRoot.get(snapshot.serializedReplica) !== snapshot) continue;
    exactRoots.add(snapshot.serializedReplica);
    copies.push(
      summarizeCopy(
        sourceOwnerKey,
        {
          key: 'journal:' + snapshot.sequence,
          persistence: 'journal-verified',
          sequence: snapshot.sequence,
          capturedAt: snapshot.capturedAt,
          reason: snapshot.reason,
          serializedReplica: snapshot.serializedReplica,
        },
        displayedCanonical,
      ),
    );
  }

  const journalVerifiedCount = exactRoots.size;

  let memoryOnlyCount = 0;
  for (const candidate of pending) {
    assertReplicaRecoverySnapshot(sourceOwnerKey, candidate.serializedReplica);
    if (exactRoots.has(candidate.serializedReplica)) continue;
    exactRoots.add(candidate.serializedReplica);
    memoryOnlyCount += 1;
    copies.push(
      summarizeCopy(
        sourceOwnerKey,
        {
          key: 'memory:' + memoryOnlyCount,
          persistence: 'memory-only',
          sequence: null,
          capturedAt: null,
          reason: candidate.reason,
          serializedReplica: candidate.serializedReplica,
        },
        displayedCanonical,
      ),
    );
  }

  if (!exactRoots.has(displayedSerializedReplica)) {
    copies.push(
      summarizeCopy(
        sourceOwnerKey,
        {
          key: 'displayed',
          persistence: 'displayed-only',
          sequence: null,
          capturedAt: null,
          reason: null,
          serializedReplica: displayedSerializedReplica,
        },
        displayedCanonical,
      ),
    );
  }

  return Object.freeze({
    sourceOwnerKey,
    inventoryComplete: input.inventoryComplete ?? true,
    preservedCount: journalVerifiedCount + memoryOnlyCount,
    journalVerifiedCount,
    memoryOnlyCount,
    hasUnverifiedCopies: memoryOnlyCount > 0,
    copies: Object.freeze(copies),
  }) as ReplicaRecoveryCatalog;
}
