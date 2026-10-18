import { describe, expect, it } from 'vitest';
import {
  parseReplicaRecoveryView,
  ReplicaRecoveryViewError,
  replicaRecoveryViewOwnerKey,
  serializeReplicaRecoveryView,
} from './replica-recovery-selection';

const sourceOwner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.11111111-1111-4111-8111-111111111111';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.22222222-2222-4222-8222-222222222222';

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

describe('recovery view selection', () => {
  it('uses a domain-separated key and round-trips the exact replica bytes', () => {
    const serializedReplica = replica('kept');
    const raw = serializeReplicaRecoveryView({
      sourceOwnerKey: sourceOwner,
      sequence: 2,
      serializedReplica,
    });

    expect(replicaRecoveryViewOwnerKey(sourceOwner)).toBe(
      'iris.recovery-view.v1.' + encodeURIComponent(sourceOwner),
    );
    expect(replicaRecoveryViewOwnerKey(sourceOwner)).not.toBe(sourceOwner);
    expect(parseReplicaRecoveryView(raw, sourceOwner)).toEqual({
      version: 1,
      ownerKey: replicaRecoveryViewOwnerKey(sourceOwner),
      sourceOwnerKey: sourceOwner,
      sequence: 2,
      serializedReplica,
    });
  });

  it('rejects a credential-like field before accepting the record', () => {
    const raw = JSON.stringify({
      version: 1,
      ownerKey: replicaRecoveryViewOwnerKey(sourceOwner),
      sourceOwnerKey: sourceOwner,
      sequence: 1,
      serializedReplica: replica('clean'),
      token: 'session-secret',
    });

    expect(() => parseReplicaRecoveryView(raw, sourceOwner)).toThrow(ReplicaRecoveryViewError);
    expect(() => parseReplicaRecoveryView(raw, sourceOwner)).toThrow(/credential-like/);
  });

  it('rejects an unknown field, a mismatched owner, and a foreign replica', () => {
    const valid = JSON.parse(
      serializeReplicaRecoveryView({
        sourceOwnerKey: sourceOwner,
        sequence: 1,
        serializedReplica: replica('clean'),
      }),
    ) as Record<string, unknown>;

    expect(() =>
      parseReplicaRecoveryView(JSON.stringify({ ...valid, extra: true }), sourceOwner),
    ).toThrow(/ownership or shape/);
    expect(() => parseReplicaRecoveryView(JSON.stringify(valid), otherOwner)).toThrow(
      /ownership or shape/,
    );
    expect(() =>
      parseReplicaRecoveryView(
        serializeReplicaRecoveryView({
          sourceOwnerKey: otherOwner,
          sequence: 1,
          serializedReplica: replica('other', otherOwner),
        }),
        sourceOwner,
      ),
    ).toThrow(/ownership or shape/);
  });
});
