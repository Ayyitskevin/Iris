import { describe, expect, it } from 'vitest';
import type { Note, SyncMutation } from '@iris/shared';
import {
  buildReplicaRecoveryCatalog,
  canonicalReplica,
  type PendingReplicaRecovery,
} from './replica-recovery-catalog';
import {
  parseReplicaRecoveryEnvelope,
  replicaRecoveryJournalOwnerKey,
  type ReplicaRecoveryEnvelope,
  type ReplicaRecoveryReason,
} from './replica-recovery-journal';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '11111111-1111-4111-8111-111111111111';
const ownerKey = workspaceId + '.' + userId;
const capturedAt = '2026-07-19T14:00:00.000Z';

function note(index: number, deleted = false): Note {
  const id = `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
  return {
    id,
    workspaceId,
    title: 'Title ' + index + ' '.repeat(140),
    bodyMd: `Body ${index}\nwith   spacing ${'x'.repeat(180)}`,
    folder: null,
    tags: [],
    version: 1,
    createdAt: capturedAt,
    updatedAt: capturedAt,
    deletedAt: deleted ? capturedAt : null,
  };
}

function mutation(noteValue: Note, label: string): SyncMutation {
  return {
    opId: 'op-' + label,
    type: 'upsert',
    note: {
      id: noteValue.id,
      title: noteValue.title,
      bodyMd: noteValue.bodyMd,
      folder: noteValue.folder,
      tags: noteValue.tags,
    },
    baseVersion: noteValue.version,
  };
}

function replica(
  label: string,
  options: { complex?: boolean; noteValues?: Note[]; reverseRootKeys?: boolean } = {},
): string {
  const noteValues = options.noteValues ?? [note(1)];
  const notes = Object.fromEntries(noteValues.map((value) => [value.id, value]));
  const queued = mutation(noteValues[0]!, label);
  const root = {
    version: 2,
    ownerKey,
    userId,
    workspaceId,
    notes,
    syncCursor: label,
    deviceId: 'device-test',
    outbox: options.complex ? [queued] : [],
    pendingPush: options.complex ? [{ ...queued, opId: queued.opId + '-pending' }] : null,
    syncIssue: options.complex
      ? {
          code: 'sync-held',
          message: 'Needs attention',
          affectedOpIds: [queued.opId],
          recoveryKind: 'retry' as const,
        }
      : null,
    conflicts: options.complex
      ? {
          [noteValues[0]!.id]: {
            noteId: noteValues[0]!.id,
            localMutation: queued,
            serverNote: noteValues[0]!,
            detectedAt: capturedAt,
          },
        }
      : {},
  };
  if (!options.reverseRootKeys) return JSON.stringify(root);
  return JSON.stringify(
    Object.fromEntries(Object.entries(root).reverse()) as unknown as typeof root,
  );
}

function envelope(
  roots: readonly string[],
  reasons: readonly ReplicaRecoveryReason[] = roots.map(() => 'stale-writer'),
): ReplicaRecoveryEnvelope {
  const raw = JSON.stringify({
    version: 1,
    ownerKey: replicaRecoveryJournalOwnerKey(ownerKey),
    sourceOwnerKey: ownerKey,
    snapshots: roots.map((serializedReplica, index) => ({
      sequence: index + 1,
      capturedAt: new Date(Date.parse(capturedAt) + index * 1_000).toISOString(),
      reason: reasons[index],
      serializedReplica,
    })),
  });
  return parseReplicaRecoveryEnvelope(raw, ownerKey);
}

describe('replica recovery catalog', () => {
  it('keeps verified and memory-only copies distinct and summarizes each exact branch', () => {
    const detailed = replica('detailed', {
      complex: true,
      noteValues: [note(1), note(2, true), note(3), note(4), note(5), note(6)],
    });
    const second = replica('second');
    const pendingRoot = replica('pending');
    const pending: PendingReplicaRecovery[] = [
      { serializedReplica: pendingRoot, reason: 'session-departure' },
    ];

    const catalog = buildReplicaRecoveryCatalog({
      sourceOwnerKey: ownerKey,
      envelope: envelope([detailed, second], ['stale-writer', 'session-rejected']),
      pending,
      displayedSerializedReplica: pendingRoot,
    });

    expect(catalog).not.toBeNull();
    expect(catalog).toMatchObject({
      inventoryComplete: true,
      preservedCount: 3,
      journalVerifiedCount: 2,
      memoryOnlyCount: 1,
      hasUnverifiedCopies: true,
    });
    expect(catalog!.copies.map((copy) => [copy.persistence, copy.sequence])).toEqual([
      ['journal-verified', 1],
      ['journal-verified', 2],
      ['memory-only', null],
    ]);
    expect(catalog!.copies[0]).toMatchObject({
      liveNoteCount: 5,
      deletedNoteCount: 1,
      outboxCount: 1,
      pendingPushCount: 1,
      conflictCount: 1,
      hasSyncIssue: true,
      omittedNotePreviewCount: 1,
      matchesDisplayedProjection: false,
    });
    expect(catalog!.copies[0]!.notePreviews).toHaveLength(5);
    expect(catalog!.copies[0]!.notePreviews[0]!.title.length).toBeLessThanOrEqual(120);
    expect(catalog!.copies[0]!.notePreviews[0]!.body.length).toBeLessThanOrEqual(160);
    expect(catalog!.copies[2]!.matchesDisplayedProjection).toBe(true);
  });

  it('adds the currently displayed root when it is not one of the preserved copies', () => {
    const preserved = replica('loser');
    const displayed = replica('authoritative');

    const catalog = buildReplicaRecoveryCatalog({
      sourceOwnerKey: ownerKey,
      envelope: envelope([preserved]),
      pending: [],
      displayedSerializedReplica: displayed,
    });

    expect(catalog!.preservedCount).toBe(1);
    expect(catalog!.copies.map((copy) => copy.persistence)).toEqual([
      'journal-verified',
      'displayed-only',
    ]);
    expect(catalog!.copies[1]).toMatchObject({
      sequence: null,
      capturedAt: null,
      reason: null,
      matchesDisplayedProjection: true,
    });
  });

  it('marks every structurally identical exact root without inventing one preferred sequence', () => {
    const normal = replica('same');
    const reordered = replica('same', { reverseRootKeys: true });
    expect(normal).not.toBe(reordered);
    expect(canonicalReplica(normal)).toBe(canonicalReplica(reordered));

    const catalog = buildReplicaRecoveryCatalog({
      sourceOwnerKey: ownerKey,
      envelope: envelope([normal, reordered]),
      pending: [],
      displayedSerializedReplica: normal,
    });

    expect(catalog!.copies).toHaveLength(2);
    expect(catalog!.copies.map((copy) => copy.matchesDisplayedProjection)).toEqual([true, true]);
    expect(catalog!.copies.map((copy) => copy.sequence)).toEqual([1, 2]);
  });

  it('shows one exact root card with its latest durable provenance', () => {
    const root = replica('same-exact-root');
    const catalog = buildReplicaRecoveryCatalog({
      sourceOwnerKey: ownerKey,
      envelope: envelope(
        [root, root, root],
        ['stale-writer', 'legacy-divergence', 'session-departure'],
      ),
      pending: [],
      displayedSerializedReplica: root,
    });

    expect(catalog).toMatchObject({
      preservedCount: 1,
      journalVerifiedCount: 1,
      copies: [
        expect.objectContaining({
          sequence: 2,
          reason: 'legacy-divergence',
          matchesDisplayedProjection: true,
        }),
      ],
    });
  });

  it('shows a byte-distinct displayed root even when a preserved root is structurally equal', () => {
    const displayed = replica('same');
    const preserved = replica('same', { reverseRootKeys: true });
    expect(displayed).not.toBe(preserved);
    expect(canonicalReplica(displayed)).toBe(canonicalReplica(preserved));

    const catalog = buildReplicaRecoveryCatalog({
      sourceOwnerKey: ownerKey,
      envelope: envelope([preserved]),
      pending: [],
      displayedSerializedReplica: displayed,
    });

    expect(catalog!.preservedCount).toBe(1);
    expect(catalog!.copies.map((copy) => copy.persistence)).toEqual([
      'journal-verified',
      'displayed-only',
    ]);
    expect(catalog!.copies.map((copy) => copy.matchesDisplayedProjection)).toEqual([true, true]);
  });

  it('keeps __proto__ note ids in canonical comparisons instead of mutating the accumulator', () => {
    const withProtoValue = JSON.parse(replica('proto')) as {
      notes: Record<string, Note>;
    };
    const protoNote = { ...note(7), id: '__proto__' };
    withProtoValue.notes = Object.fromEntries([[protoNote.id, protoNote]]);
    const withProto = JSON.stringify(withProtoValue);
    const withoutProtoValue = JSON.parse(replica('proto')) as {
      notes: Record<string, Note>;
    };
    withoutProtoValue.notes = {};
    const withoutProto = JSON.stringify(withoutProtoValue);

    expect(canonicalReplica(withProto)).not.toBe(canonicalReplica(withoutProto));
    const catalog = buildReplicaRecoveryCatalog({
      sourceOwnerKey: ownerKey,
      envelope: envelope([withProto]),
      pending: [],
      displayedSerializedReplica: withoutProto,
    });
    expect(catalog!.copies.map((copy) => copy.persistence)).toEqual([
      'journal-verified',
      'displayed-only',
    ]);
  });

  it('marks an inventory partial when durable recovery storage could not be read', () => {
    const pending = replica('memory-only');
    const catalog = buildReplicaRecoveryCatalog({
      sourceOwnerKey: ownerKey,
      envelope: null,
      pending: [{ serializedReplica: pending, reason: 'stale-writer' }],
      displayedSerializedReplica: pending,
      inventoryComplete: false,
    });

    expect(catalog).toMatchObject({
      inventoryComplete: false,
      preservedCount: 1,
      memoryOnlyCount: 1,
    });
  });

  it('returns no recovery inventory when neither durable nor memory-only copies exist', () => {
    expect(
      buildReplicaRecoveryCatalog({
        sourceOwnerKey: ownerKey,
        envelope: null,
        pending: [],
        displayedSerializedReplica: replica('displayed'),
      }),
    ).toBeNull();
  });
});
