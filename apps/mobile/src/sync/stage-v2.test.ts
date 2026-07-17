import { describe, expect, it } from 'vitest';
import {
  MAX_NOTE_BODY_BYTES,
  SYNC_PUSH_LIMIT,
  SYNC_PUSH_MAX_BYTES,
  SYNC_V2_RESOURCE_SET,
  jsonEncodedStringByteLength,
  syncV2PushRequestByteLength,
  type SyncV2Mutation,
  type SyncV2NoteResource,
  type SyncV2PushRequest,
} from '@iris/shared';

import {
  createEmptySyncV2Replica,
  parsePersistedSyncV2Replica,
  serializePersistedSyncV2Replica,
  SyncV2ReplicaIntegrityError,
  validatePersistedSyncV2Replica,
  type PersistedSyncV2Replica,
} from '../state/sync-v2-replica';
import { stageSyncV2PushRequest } from './stage-v2';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const deviceId = 'device-stage-v2';

function noteId(index: number): string {
  return `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`;
}

function mutation(index: number, bodyMd = `Body ${index}`): SyncV2Mutation {
  return {
    opId: `op-${index}`,
    type: 'upsert',
    resource: {
      type: 'note',
      id: noteId(index),
      data: {
        title: `Title ${index}`,
        bodyMd,
        folder: null,
        tags: [`tag-${index}`],
      },
    },
    baseVersion: 0,
  };
}

function resourceFor(item: SyncV2Mutation): SyncV2NoteResource {
  return {
    type: 'note',
    id: item.resource.id,
    data: {
      workspaceId,
      ...item.resource.data,
      tags: [...item.resource.data.tags],
      version: item.baseVersion,
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:00:00.000Z',
      deletedAt: item.type === 'delete' ? '2026-07-16T12:00:00.000Z' : null,
    },
  };
}

function replicaWithOutbox(items: SyncV2Mutation[]): PersistedSyncV2Replica {
  const empty = createEmptySyncV2Replica({ userId, workspaceId, deviceId });
  return validatePersistedSyncV2Replica({
    ...empty,
    resources: Object.fromEntries(items.map((item) => [item.resource.id, resourceFor(item)])),
    outbox: items,
  });
}

function request(items: SyncV2Mutation[]): SyncV2PushRequest {
  return {
    resourceSet: SYNC_V2_RESOURCE_SET,
    deviceId,
    mutations: items,
  };
}

describe('Sync v2 pending-request staging', () => {
  it('leaves an empty queue and an owner-local terminal hold unstaged', () => {
    const empty = createEmptySyncV2Replica({ userId, workspaceId, deviceId });
    const queued = replicaWithOutbox([mutation(1)]);
    const held = validatePersistedSyncV2Replica({
      ...queued,
      syncIssue: {
        code: 'retry_later',
        message: 'Recovery must be explicit.',
        affectedOpIds: ['op-1'],
        recoveryKind: 'retry',
      },
    });

    expect(stageSyncV2PushRequest(empty)).toEqual(empty);
    expect(stageSyncV2PushRequest(held)).toEqual(held);
    expect(stageSyncV2PushRequest(held).pendingPush).toBeNull();
    expect(stageSyncV2PushRequest(held).outbox).toEqual(queued.outbox);
  });

  it('preserves an existing complete pending envelope byte-for-byte', () => {
    const item = mutation(1);
    const pending = request([item]);
    const replica = validatePersistedSyncV2Replica({
      ...replicaWithOutbox([item]),
      pendingPush: pending,
    });
    const before = serializePersistedSyncV2Replica(replica);

    const staged = stageSyncV2PushRequest(replica);

    expect(staged.pendingPush).toEqual(pending);
    expect(staged.pendingPush).not.toBe(replica.pendingPush);
    expect(serializePersistedSyncV2Replica(staged)).toBe(before);
  });

  it('stages the resource set, device, and exact mutation envelope without consuming outbox', () => {
    const items = [mutation(1), mutation(2)];
    const replica = replicaWithOutbox(items);
    const before = structuredClone(replica);

    const staged = stageSyncV2PushRequest(replica);

    expect(staged.pendingPush).toEqual({
      resourceSet: SYNC_V2_RESOURCE_SET,
      deviceId,
      mutations: items,
    });
    expect(staged.outbox).toEqual(items);
    expect(replica).toEqual(before);
    expect(staged.pendingPush?.mutations[0]).not.toBe(replica.outbox[0]);
  });

  it('stages at most six operations while leaving the complete queue durable', () => {
    const items = Array.from({ length: SYNC_PUSH_LIMIT + 1 }, (_, index) => mutation(index + 1));

    const staged = stageSyncV2PushRequest(replicaWithOutbox(items));

    expect(staged.pendingPush?.mutations).toEqual(items.slice(0, SYNC_PUSH_LIMIT));
    expect(staged.pendingPush?.mutations).toHaveLength(SYNC_PUSH_LIMIT);
    expect(staged.outbox).toEqual(items);
  });

  it('accepts exact JSON-encoded UTF-8 note boundaries and measures actual request bytes', () => {
    const exactBody = '🙂'.repeat(MAX_NOTE_BODY_BYTES / 4);
    expect(jsonEncodedStringByteLength(exactBody)).toBe(MAX_NOTE_BODY_BYTES);
    const items = Array.from({ length: SYNC_PUSH_LIMIT }, (_, index) =>
      mutation(index + 1, exactBody),
    );
    const fullRequest = request(items);
    expect(syncV2PushRequestByteLength(fullRequest)).toBeGreaterThan(
      JSON.stringify(fullRequest).length,
    );
    expect(syncV2PushRequestByteLength(fullRequest)).toBeLessThanOrEqual(SYNC_PUSH_MAX_BYTES);

    const staged = stageSyncV2PushRequest(replicaWithOutbox(items));

    expect(staged.pendingPush?.mutations).toHaveLength(SYNC_PUSH_LIMIT);
    expect(syncV2PushRequestByteLength(staged.pendingPush!)).toBe(
      syncV2PushRequestByteLength(fullRequest),
    );
  });

  it('rejects an over-field-limit UTF-8 mutation as corrupt persisted state before staging', () => {
    const oversizedBody = '🪻'.repeat(Math.ceil(SYNC_PUSH_MAX_BYTES / 4));
    const oversized = mutation(1, oversizedBody);
    const raw = {
      ...createEmptySyncV2Replica({ userId, workspaceId, deviceId }),
      resources: { [oversized.resource.id]: resourceFor(oversized) },
      outbox: [oversized],
    };
    const before = structuredClone(raw);
    expect(syncV2PushRequestByteLength(request([oversized]))).toBeGreaterThan(SYNC_PUSH_MAX_BYTES);

    expect(() => stageSyncV2PushRequest(raw)).toThrowError(SyncV2ReplicaIntegrityError);
    expect(() => stageSyncV2PushRequest(raw)).toThrow('invalid outbox mutation');
    expect(raw).toEqual(before);
  });

  it('replays the same staged request after serialization and restart', () => {
    const items = [mutation(1), mutation(2)];
    const staged = stageSyncV2PushRequest(replicaWithOutbox(items));
    const serialized = serializePersistedSyncV2Replica(staged);

    const restarted = parsePersistedSyncV2Replica(serialized);
    const replayed = stageSyncV2PushRequest(restarted);

    expect(replayed.pendingPush).toEqual(staged.pendingPush);
    expect(replayed.outbox).toEqual(items);
    expect(serializePersistedSyncV2Replica(replayed)).toBe(serialized);
  });

  it('does not mutate or retain aliases into the supplied root', () => {
    const item = mutation(1);
    const input = replicaWithOutbox([item]);
    const snapshot = structuredClone(input);

    const staged = stageSyncV2PushRequest(input);

    expect(input).toEqual(snapshot);
    input.outbox[0]!.resource.data.bodyMd = 'mutated after staging';
    input.outbox[0]!.resource.data.tags.push('later');
    input.resources[item.resource.id]!.data.title = 'mutated projection';

    expect(staged.pendingPush?.mutations[0]?.resource.data).toEqual(item.resource.data);
    expect(staged.outbox[0]?.resource.data).toEqual(item.resource.data);
    expect(staged.resources[item.resource.id]?.data.title).toBe(item.resource.data.title);
  });
});
