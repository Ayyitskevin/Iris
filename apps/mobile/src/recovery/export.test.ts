import { describe, expect, it } from 'vitest';
import {
  createReplicaRecoveryExport,
  parseReplicaRecoveryExport,
  REPLICA_RECOVERY_EXPORT_FORMAT,
  ReplicaRecoveryExportError,
  replicaRecoveryExportFileName,
} from './export';
import {
  parseReplicaRecoveryEnvelope,
  replicaRecoveryJournalOwnerKey,
  type ReplicaRecoveryEnvelope,
} from '../state/replica-recovery-journal';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '11111111-1111-4111-8111-111111111111';
const ownerKey = workspaceId + '.' + userId;
const exportedAt = '2026-07-19T15:30:00.000Z';

function replica(label: string, reverse = false): string {
  const value = {
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
  };
  return JSON.stringify(reverse ? Object.fromEntries(Object.entries(value).reverse()) : value);
}

function envelope(roots: readonly string[]): ReplicaRecoveryEnvelope {
  return parseReplicaRecoveryEnvelope(
    JSON.stringify({
      version: 1,
      ownerKey: replicaRecoveryJournalOwnerKey(ownerKey),
      sourceOwnerKey: ownerKey,
      snapshots: roots.map((serializedReplica, index) => ({
        sequence: index + 1,
        capturedAt: new Date(Date.parse(exportedAt) - (roots.length - index) * 1_000).toISOString(),
        reason: index === 0 ? 'stale-writer' : 'session-departure',
        serializedReplica,
      })),
    }),
    ownerKey,
  );
}

describe('replica recovery export', () => {
  it('round-trips every journal root byte-for-byte and references the exact displayed root', () => {
    const first = replica('same');
    const reordered = replica('same', true);
    const serialized = createReplicaRecoveryExport({
      envelope: envelope([first, reordered]),
      displayedSerializedReplica: first,
      exportedAt,
    });
    const parsed = parseReplicaRecoveryExport(serialized, ownerKey);

    expect(parsed.format).toBe(REPLICA_RECOVERY_EXPORT_FORMAT);
    expect(parsed.snapshots.map((snapshot) => snapshot.serializedReplica)).toEqual([
      first,
      reordered,
    ]);
    expect(parsed.displayed).toEqual({ kind: 'journal-match', sequences: [1] });
    expect(JSON.stringify(parsed)).toBe(serialized);
    expect(serialized).not.toContain('bearer-secret');
  });

  it('embeds byte-distinct displayed JSON even when journal roots are structurally equal', () => {
    const first = replica('same');
    const reordered = replica('same', true);
    const displayed = JSON.stringify(JSON.parse(first) as unknown, null, 2);
    expect(displayed).not.toBe(first);
    expect(displayed).not.toBe(reordered);

    const parsed = parseReplicaRecoveryExport(
      createReplicaRecoveryExport({
        envelope: envelope([first, reordered]),
        displayedSerializedReplica: displayed,
        exportedAt,
      }),
      ownerKey,
    );

    expect(parsed.snapshots.map((snapshot) => snapshot.serializedReplica)).toEqual([
      first,
      reordered,
    ]);
    expect(parsed.displayed).toEqual({ kind: 'embedded', serializedReplica: displayed });
  });

  it('embeds the exact displayed root only when it differs from every journal copy', () => {
    const preserved = replica('preserved');
    const displayed = replica('authoritative');
    const parsed = parseReplicaRecoveryExport(
      createReplicaRecoveryExport({
        envelope: envelope([preserved]),
        displayedSerializedReplica: displayed,
        exportedAt,
      }),
      ownerKey,
    );

    expect(parsed.displayed).toEqual({ kind: 'embedded', serializedReplica: displayed });
    expect(parsed.snapshots[0]!.serializedReplica).toBe(preserved);
  });

  it('fails closed on widened, foreign, future, or credential-bearing bundles', () => {
    const valid = createReplicaRecoveryExport({
      envelope: envelope([replica('valid')]),
      displayedSerializedReplica: replica('displayed'),
      exportedAt,
    });
    const parsed = JSON.parse(valid) as Record<string, unknown>;

    expect(() =>
      parseReplicaRecoveryExport(JSON.stringify({ ...parsed, unexpected: true }), ownerKey),
    ).toThrow(ReplicaRecoveryExportError);
    expect(() =>
      parseReplicaRecoveryExport(JSON.stringify({ ...parsed, version: 2 }), ownerKey),
    ).toThrow(ReplicaRecoveryExportError);
    expect(() => parseReplicaRecoveryExport(valid, 'foreign.owner')).toThrow(
      ReplicaRecoveryExportError,
    );

    const snapshots = parsed.snapshots as Array<Record<string, unknown>>;
    const credentialRoot = {
      ...(JSON.parse(snapshots[0]!.serializedReplica as string) as Record<string, unknown>),
      authToken: 'bearer-secret',
    };
    const credentialBundle = {
      ...parsed,
      snapshots: [
        {
          ...snapshots[0],
          serializedReplica: JSON.stringify(credentialRoot),
        },
      ],
    };
    expect(() => parseReplicaRecoveryExport(JSON.stringify(credentialBundle), ownerKey)).toThrow();
  });

  it('rejects contradictory displayed metadata instead of normalizing it', () => {
    const root = replica('same');
    const serialized = createReplicaRecoveryExport({
      envelope: envelope([root]),
      displayedSerializedReplica: root,
      exportedAt,
    });
    const value = JSON.parse(serialized) as Record<string, unknown>;

    expect(() =>
      parseReplicaRecoveryExport(
        JSON.stringify({
          ...value,
          displayed: { kind: 'embedded', serializedReplica: root },
        }),
        ownerKey,
      ),
    ).toThrow('duplicated an exact displayed journal projection');
    expect(() =>
      parseReplicaRecoveryExport(
        JSON.stringify({
          ...value,
          displayed: { kind: 'journal-match', sequences: [1, 1] },
        }),
        ownerKey,
      ),
    ).toThrow('displayed projection is invalid');
  });

  it('creates a sanitized owner-free filename from an injected nonce', () => {
    const name = replicaRecoveryExportFileName(exportedAt, 'safe nonce/../');
    expect(name).toBe('iris-recovery-2026-07-19_15-30-00-000-safenonce.json');
    expect(name).not.toContain(workspaceId);
    expect(name).not.toContain(userId);
    expect(() => replicaRecoveryExportFileName('not-a-time', 'safe')).toThrow(
      ReplicaRecoveryExportError,
    );
  });
});
