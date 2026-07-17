import { describe, expect, it } from 'vitest';
import {
  SYNC_V2_RESOURCE_SET,
  type SyncV2Mutation,
  type SyncV2NoteResource,
  type SyncV2PushRequest,
  type SyncV2PushResponse,
} from '@iris/shared';

import {
  createEmptySyncV2Replica,
  SyncV2ReplicaIntegrityError,
  validatePersistedSyncV2Replica,
  type PersistedSyncV2Replica,
  type SyncV2Issue,
} from '../state/sync-v2-replica';
import { applySyncV2PushResponse, type SyncV2ApplicationContext } from './apply-v2';
import { SyncProtocolError } from './reconcile';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherWorkspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const deviceId = 'device-a';
const detectedAt = '2026-07-16T16:00:00.000Z';
const noteA = '11111111-1111-4111-8111-111111111111';
const noteB = '22222222-2222-4222-8222-222222222222';
const noteC = '33333333-3333-4333-8333-333333333333';

function mutation(
  opId: string,
  type: SyncV2Mutation['type'],
  id: string,
  overrides: Partial<SyncV2Mutation['resource']['data']> = {},
): SyncV2Mutation {
  return {
    opId,
    type,
    resource: {
      type: 'note',
      id,
      data: {
        title: `Local ${opId}`,
        bodyMd: `Local body ${opId}`,
        folder: null,
        tags: [`tag-${opId}`],
        ...overrides,
      },
    },
    baseVersion: type === 'upsert' ? 0 : 1,
  };
}

function resource(
  id: string,
  overrides: Partial<SyncV2NoteResource['data']> = {},
): SyncV2NoteResource {
  return {
    type: 'note',
    id,
    data: {
      workspaceId,
      title: `Projection ${id}`,
      bodyMd: `Projection body ${id}`,
      folder: null,
      tags: [],
      version: 1,
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:30:00.000Z',
      deletedAt: null,
      ...overrides,
    },
  };
}

function localProjection(
  value: SyncV2Mutation,
  overrides: Partial<SyncV2NoteResource['data']> = {},
): SyncV2NoteResource {
  return resource(value.resource.id, {
    ...value.resource.data,
    version: value.baseVersion,
    deletedAt: value.type === 'delete' ? '2026-07-16T14:00:00.000Z' : null,
    ...overrides,
  });
}

function request(mutations: SyncV2Mutation[], requestDeviceId = deviceId): SyncV2PushRequest {
  return {
    resourceSet: SYNC_V2_RESOURCE_SET,
    deviceId: requestDeviceId,
    mutations,
  };
}

function response(overrides: Partial<SyncV2PushResponse> = {}): SyncV2PushResponse {
  return {
    resourceSet: SYNC_V2_RESOURCE_SET,
    applied: [],
    conflicts: [],
    ...overrides,
  };
}

function context(overrides: Partial<SyncV2ApplicationContext> = {}): SyncV2ApplicationContext {
  return {
    workspaceId,
    deviceId,
    detectedAt,
    ...overrides,
  };
}

interface ReplicaInput {
  sent: SyncV2Mutation[];
  resources: Record<string, SyncV2NoteResource>;
  outbox?: SyncV2Mutation[];
  syncIssue?: SyncV2Issue | null;
  owner?: { userId: string; workspaceId: string; deviceId: string };
}

function replica(input: ReplicaInput): PersistedSyncV2Replica {
  const owner = input.owner ?? { userId, workspaceId, deviceId };
  return validatePersistedSyncV2Replica({
    ...createEmptySyncV2Replica(owner),
    resources: input.resources,
    outbox: input.outbox ?? input.sent,
    pendingPush: request(input.sent, owner.deviceId),
    syncIssue: input.syncIssue ?? null,
  });
}

function applied(mutation: SyncV2Mutation, authoritative?: SyncV2NoteResource) {
  return { opId: mutation.opId, resource: authoritative };
}

function conflict(mutation: SyncV2Mutation, authoritative: SyncV2NoteResource) {
  return {
    opId: mutation.opId,
    reason: 'version_mismatch' as const,
    serverResource: authoritative,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

describe('Sync v2 atomic push-result application', () => {
  it('applies authoritative upserts and resurrections and clears only their staged work', () => {
    for (const type of ['upsert', 'resurrect'] as const) {
      const sent = mutation(`op-${type}`, type, noteA);
      const local = localProjection(sent);
      const authoritative = resource(noteA, {
        title: `Authoritative ${type}`,
        bodyMd: `Server ${type}`,
        tags: ['server'],
        version: 2,
        updatedAt: '2026-07-16T15:00:00.000Z',
        deletedAt: null,
      });
      const current = replica({ sent: [sent], resources: { [noteA]: local } });

      const next = applySyncV2PushResponse(
        current,
        request([sent]),
        response({ applied: [applied(sent, authoritative)] }),
        context(),
      );

      expect(next.resources).toEqual({ [noteA]: authoritative });
      expect(next.outbox).toEqual([]);
      expect(next.pendingPush).toBeNull();
    }
  });

  it('retains an authoritative tombstone for an applied delete', () => {
    const sent = mutation('op-delete', 'delete', noteA);
    const local = resource(noteA, {
      ...sent.resource.data,
      deletedAt: '2026-07-16T14:00:00.000Z',
    });
    const tombstone = resource(noteA, {
      title: sent.resource.data.title,
      bodyMd: sent.resource.data.bodyMd,
      tags: sent.resource.data.tags,
      version: 2,
      updatedAt: '2026-07-16T15:00:00.000Z',
      deletedAt: '2026-07-16T15:00:00.000Z',
    });
    const current = replica({ sent: [sent], resources: { [noteA]: local } });

    const next = applySyncV2PushResponse(
      current,
      request([sent]),
      response({ applied: [applied(sent, tombstone)] }),
      context(),
    );

    expect(next.resources).toEqual({ [noteA]: tombstone });
    expect(next.outbox).toEqual([]);
    expect(next.pendingPush).toBeNull();
  });

  it('removes the projection for an idempotent applied delete with no server resource', () => {
    const sent = mutation('op-delete-absent', 'delete', noteA);
    const current = replica({
      sent: [sent],
      resources: {
        [noteA]: resource(noteA, {
          ...sent.resource.data,
          deletedAt: '2026-07-16T14:00:00.000Z',
        }),
      },
    });

    const next = applySyncV2PushResponse(
      current,
      request([sent]),
      response({ applied: [applied(sent)] }),
      context(),
    );

    expect(next.resources).toEqual({});
    expect(next.outbox).toEqual([]);
    expect(next.pendingPush).toBeNull();
  });

  it('applies mixed reordered result buckets without dropping independent resources', () => {
    const first = mutation('op-first-conflict', 'upsert', noteA);
    const second = mutation('op-second-applied', 'upsert', noteB);
    const third = mutation('op-third-delete', 'delete', noteC);
    const firstServer = resource(noteA, { bodyMd: 'Changed elsewhere', version: 5 });
    const secondServer = resource(noteB, { bodyMd: 'Applied second', version: 2 });
    const thirdServer = resource(noteC, {
      bodyMd: 'Deleted third',
      version: 4,
      deletedAt: '2026-07-16T15:20:00.000Z',
    });
    const current = replica({
      sent: [first, second, third],
      resources: {
        [noteA]: localProjection(first),
        [noteB]: localProjection(second),
        [noteC]: localProjection(third, { deletedAt: '2026-07-16T14:20:00.000Z' }),
      },
    });

    const next = applySyncV2PushResponse(
      current,
      request([first, second, third]),
      response({
        applied: [applied(third, thirdServer), applied(second, secondServer)],
        conflicts: [conflict(first, firstServer)],
      }),
      context(),
    );

    expect(next.resources).toEqual({
      [noteA]: firstServer,
      [noteB]: secondServer,
      [noteC]: thirdServer,
    });
    expect(next.conflicts[noteA]).toEqual({
      localMutation: first,
      serverResource: firstServer,
      detectedAt,
    });
    expect(next.outbox).toEqual([]);
    expect(next.pendingPush).toBeNull();
  });

  it('uses the last request-ordered outcome when one request repeats a resource id', () => {
    const first = mutation('op-same-first', 'upsert', noteA);
    const second = mutation('op-same-second', 'delete', noteA);
    const afterFirst = resource(noteA, { bodyMd: 'First operation applied', version: 2 });
    const finalServer = resource(noteA, { bodyMd: 'Delete conflicted with this head', version: 2 });
    const current = replica({
      sent: [first, second],
      outbox: [second],
      resources: {
        [noteA]: resource(noteA, {
          ...second.resource.data,
          deletedAt: '2026-07-16T14:00:00.000Z',
        }),
      },
    });

    const next = applySyncV2PushResponse(
      current,
      request([first, second]),
      response({
        applied: [applied(first, afterFirst)],
        conflicts: [conflict(second, finalServer)],
      }),
      context(),
    );

    expect(next.resources).toEqual({ [noteA]: finalServer });
    expect(next.conflicts[noteA]).toEqual({
      localMutation: second,
      serverResource: finalServer,
      detectedAt,
    });
    expect(next.outbox).toEqual([]);
  });

  it('rebases a newer draft from the final applied result for a repeated resource', () => {
    const first = mutation('op-repeat-first', 'upsert', noteA);
    const second = { ...mutation('op-repeat-second', 'upsert', noteA), baseVersion: 1 };
    const newer = mutation('op-repeat-newer', 'upsert', noteA, {
      title: 'Newest repeated-resource draft',
      bodyMd: 'Preserve this newer body',
      tags: ['newer'],
    });
    const localUpdatedAt = '2026-07-16T14:21:00.000Z';
    const current = replica({
      sent: [first, second],
      outbox: [newer],
      resources: {
        [noteA]: localProjection(newer, { updatedAt: localUpdatedAt }),
      },
    });
    const afterFirst = resource(noteA, { bodyMd: 'First applied head', version: 1 });
    const finalServer = resource(noteA, { bodyMd: 'Final applied head', version: 2 });

    const next = applySyncV2PushResponse(
      current,
      request([first, second]),
      response({ applied: [applied(second, finalServer), applied(first, afterFirst)] }),
      context(),
    );

    expect(next.outbox).toEqual([{ ...newer, baseVersion: finalServer.data.version }]);
    expect(next.resources[noteA]).toEqual({
      ...finalServer,
      data: {
        ...finalServer.data,
        ...newer.resource.data,
        tags: [...newer.resource.data.tags],
        updatedAt: localUpdatedAt,
        deletedAt: null,
      },
    });
    expect(next.pendingPush).toBeNull();
  });

  it('rebases a newer local edit while preserving its projection content and timestamps', () => {
    const sent = mutation('op-staged', 'upsert', noteA, { bodyMd: 'Older staged edit' });
    const newer = {
      ...mutation('op-newer', 'delete', noteA, {
        title: 'Newest local title',
        bodyMd: 'Newest local body',
        folder: 'Local folder',
        tags: ['newest', 'local'],
      }),
      baseVersion: 1,
    };
    const localUpdatedAt = '2026-07-16T14:11:00.000Z';
    const localDeletedAt = '2026-07-16T14:12:00.000Z';
    const localProjection = resource(noteA, {
      ...newer.resource.data,
      version: 1,
      updatedAt: localUpdatedAt,
      deletedAt: localDeletedAt,
    });
    const authoritative = resource(noteA, {
      title: sent.resource.data.title,
      bodyMd: sent.resource.data.bodyMd,
      tags: sent.resource.data.tags,
      version: 2,
      createdAt: '2026-07-16T11:00:00.000Z',
      updatedAt: '2026-07-16T15:00:00.000Z',
    });
    const current = replica({
      sent: [sent],
      outbox: [newer],
      resources: { [noteA]: localProjection },
    });

    const next = applySyncV2PushResponse(
      current,
      request([sent]),
      response({ applied: [applied(sent, authoritative)] }),
      context(),
    );

    expect(next.outbox).toEqual([{ ...newer, baseVersion: 2 }]);
    expect(next.resources[noteA]).toEqual({
      ...authoritative,
      data: {
        ...authoritative.data,
        ...newer.resource.data,
        tags: [...newer.resource.data.tags],
        updatedAt: localUpdatedAt,
        deletedAt: localDeletedAt,
      },
    });
    expect(next.pendingPush).toBeNull();
  });

  it('keeps an edit after staged resurrection as a separate upsert on the revived version', () => {
    const sent = mutation('op-resurrect', 'resurrect', noteA, {
      bodyMd: 'Reviewed resurrection draft',
    });
    const newer = {
      ...mutation('op-after-resurrection', 'upsert', noteA, {
        title: 'Newest title after staging',
        bodyMd: 'Newest body after staging',
        tags: ['newest'],
      }),
      baseVersion: 1,
    };
    const localUpdatedAt = '2026-07-16T14:31:00.000Z';
    const localProjection = resource(noteA, {
      ...newer.resource.data,
      version: newer.baseVersion,
      updatedAt: localUpdatedAt,
      deletedAt: null,
    });
    const revived = resource(noteA, {
      ...sent.resource.data,
      version: 2,
      updatedAt: '2026-07-16T15:30:00.000Z',
      deletedAt: null,
    });
    const current = replica({
      sent: [sent],
      outbox: [newer],
      resources: { [noteA]: localProjection },
    });

    const next = applySyncV2PushResponse(
      current,
      request([sent]),
      response({ applied: [applied(sent, revived)] }),
      context(),
    );

    expect(next.outbox).toEqual([{ ...newer, baseVersion: revived.data.version }]);
    expect(next.outbox[0]?.type).toBe('upsert');
    expect(next.resources[noteA]).toEqual({
      ...revived,
      data: {
        ...revived.data,
        ...newer.resource.data,
        tags: [...newer.resource.data.tags],
        updatedAt: localUpdatedAt,
        deletedAt: null,
      },
    });
    expect(next.pendingPush).toBeNull();
  });

  it('preserves a newer projection exactly when an applied delete has no server version', () => {
    const sent = mutation('op-old-delete', 'delete', noteA);
    const newer = mutation('op-new-create', 'upsert', noteA, { bodyMd: 'New local create' });
    const localProjection = resource(noteA, {
      ...newer.resource.data,
      version: 0,
      createdAt: '2026-07-16T14:00:00.000Z',
      updatedAt: '2026-07-16T14:01:00.000Z',
    });
    const current = replica({
      sent: [sent],
      outbox: [newer],
      resources: { [noteA]: localProjection },
    });

    const next = applySyncV2PushResponse(
      current,
      request([sent]),
      response({ applied: [applied(sent)] }),
      context(),
    );

    expect(next.resources).toEqual({ [noteA]: localProjection });
    expect(next.outbox).toEqual([newer]);
    expect(next.pendingPush).toBeNull();
  });

  it('retains the newest local conflict draft, server projection, and unrelated work', () => {
    const sent = mutation('op-sent', 'upsert', noteA, { bodyMd: 'Older staged draft' });
    const newer = {
      ...mutation('op-newest', 'upsert', noteA, { bodyMd: 'Newest local draft' }),
      baseVersion: 1,
    };
    const unrelated = mutation('op-unrelated', 'upsert', noteB, { bodyMd: 'Still queued' });
    const localA = resource(noteA, { ...newer.resource.data });
    const localB = resource(noteB, { ...unrelated.resource.data, version: 0 });
    const server = resource(noteA, { bodyMd: 'Changed elsewhere', version: 6 });
    const current = replica({
      sent: [sent],
      outbox: [newer, unrelated],
      resources: { [noteA]: localA, [noteB]: localB },
    });

    const next = applySyncV2PushResponse(
      current,
      request([sent]),
      response({ conflicts: [conflict(sent, server)] }),
      context(),
    );

    expect(next.resources).toEqual({ [noteA]: server, [noteB]: localB });
    expect(next.outbox).toEqual([unrelated]);
    expect(next.conflicts[noteA]).toEqual({
      localMutation: newer,
      serverResource: server,
      detectedAt,
    });
    expect(next.pendingPush).toBeNull();
  });

  it('rebases a newer local delete when an older upsert replays a server tombstone', () => {
    const sent = mutation('op-staged-upsert', 'upsert', noteA, {
      bodyMd: 'Older staged edit',
    });
    const newer = mutation('op-newer-delete', 'delete', noteA, {
      bodyMd: 'Newest local state before deletion',
    });
    const local = localProjection(newer, {
      updatedAt: '2026-07-16T14:40:00.000Z',
      deletedAt: '2026-07-16T14:41:00.000Z',
    });
    const tombstone = resource(noteA, {
      bodyMd: 'Deleted independently on the server',
      version: 5,
      updatedAt: '2026-07-16T15:40:00.000Z',
      deletedAt: '2026-07-16T15:40:00.000Z',
    });
    const current = replica({
      sent: [sent],
      outbox: [newer],
      resources: { [noteA]: local },
    });
    const snapshot = clone(current);

    const next = applySyncV2PushResponse(
      current,
      request([sent]),
      response({ conflicts: [conflict(sent, tombstone)] }),
      context(),
    );

    const rebased = { ...newer, baseVersion: tombstone.data.version };
    expect(next.resources[noteA]).toEqual({
      ...tombstone,
      data: {
        ...tombstone.data,
        ...newer.resource.data,
        tags: [...newer.resource.data.tags],
        updatedAt: local.data.updatedAt,
        deletedAt: local.data.deletedAt,
      },
    });
    expect(next.outbox).toEqual([rebased]);
    expect(next.conflicts).toEqual({});
    expect(next.pendingPush).toBeNull();
    expect(current).toEqual(snapshot);
  });

  it('retains a newer local delete when an older upsert conflicts with a live server head', () => {
    const sent = mutation('op-staged-upsert-live', 'upsert', noteA);
    const newer = mutation('op-newer-delete-live', 'delete', noteA);
    const local = localProjection(newer, {
      deletedAt: '2026-07-16T14:51:00.000Z',
    });
    const server = resource(noteA, {
      bodyMd: 'Still live on the server',
      version: 6,
      updatedAt: '2026-07-16T15:50:00.000Z',
      deletedAt: null,
    });
    const current = replica({
      sent: [sent],
      outbox: [newer],
      resources: { [noteA]: local },
    });

    const next = applySyncV2PushResponse(
      current,
      request([sent]),
      response({ conflicts: [conflict(sent, server)] }),
      context(),
    );

    expect(next.resources).toEqual({ [noteA]: server });
    expect(next.outbox).toEqual([]);
    expect(next.conflicts[noteA]).toEqual({
      localMutation: newer,
      serverResource: server,
      detectedAt,
    });
    expect(next.pendingPush).toBeNull();
  });

  it('retains multiple independent conflicts in the same atomic result', () => {
    const first = mutation('op-conflict-a', 'upsert', noteA);
    const second = mutation('op-conflict-b', 'delete', noteB);
    const firstServer = resource(noteA, { bodyMd: 'First server head', version: 4 });
    const secondServer = resource(noteB, { bodyMd: 'Second live server head', version: 7 });
    const current = replica({
      sent: [first, second],
      resources: {
        [noteA]: localProjection(first),
        [noteB]: localProjection(second),
      },
    });

    const next = applySyncV2PushResponse(
      current,
      request([first, second]),
      response({ conflicts: [conflict(second, secondServer), conflict(first, firstServer)] }),
      context(),
    );

    expect(next.resources).toEqual({ [noteA]: firstServer, [noteB]: secondServer });
    expect(next.conflicts).toEqual({
      [noteA]: { localMutation: first, serverResource: firstServer, detectedAt },
      [noteB]: { localMutation: second, serverResource: secondServer, detectedAt },
    });
    expect(next.outbox).toEqual([]);
    expect(next.pendingPush).toBeNull();
  });

  it('accepts canonical UUID case differences without splitting a resource identity', () => {
    const upperWorkspace = workspaceId.toUpperCase();
    const upperNote = noteA.toUpperCase();
    const sent = mutation('op-case', 'upsert', noteA);
    const current = replica({
      sent: [sent],
      resources: {
        [upperNote]: resource(upperNote, {
          workspaceId,
          ...sent.resource.data,
          version: sent.baseVersion,
        }),
      },
    });
    const authoritative = resource(noteA, { version: 2 });

    const next = applySyncV2PushResponse(
      current,
      request([sent]),
      response({ applied: [applied(sent, authoritative)] }),
      context({ workspaceId: upperWorkspace }),
    );

    expect(next.resources).toEqual({ [noteA]: authoritative });
    expect(next.workspaceId).toBe(workspaceId);
  });

  it('rejects version-zero server results before acknowledging durable work', () => {
    const sent = mutation('op-zero-authority', 'upsert', noteA);
    const current = replica({ sent: [sent], resources: { [noteA]: localProjection(sent) } });
    const versionZero = resource(noteA, { version: 0 });
    const snapshot = clone(current);
    const invalidResponses = [
      response({ applied: [applied(sent, versionZero)] }),
      response({ conflicts: [conflict(sent, versionZero)] }),
    ];

    for (const invalidResponse of invalidResponses) {
      expect(() =>
        applySyncV2PushResponse(current, request([sent]), invalidResponse, context()),
      ).toThrow('non-authoritative version');
      expect(current).toEqual(snapshot);
      expect(current.pendingPush).toEqual(request([sent]));
    }
  });

  it('requires the exact durable pending envelope and checked workspace and device context', () => {
    const sent = mutation('op-fenced', 'upsert', noteA);
    const other = mutation('op-other-envelope', 'upsert', noteB);
    const current = replica({
      sent: [sent],
      resources: { [noteA]: localProjection(sent) },
    });
    const validResponse = response({ applied: [applied(sent, resource(noteA, { version: 2 }))] });

    const cases: Array<() => PersistedSyncV2Replica> = [
      () =>
        applySyncV2PushResponse(
          { ...current, pendingPush: null },
          request([sent]),
          validResponse,
          context(),
        ),
      () =>
        applySyncV2PushResponse(
          current,
          request([other]),
          response({ applied: [applied(other, resource(noteB, { version: 2 }))] }),
          context(),
        ),
      () =>
        applySyncV2PushResponse(
          current,
          request([sent]),
          validResponse,
          context({ workspaceId: otherWorkspaceId }),
        ),
      () =>
        applySyncV2PushResponse(
          current,
          request([sent]),
          validResponse,
          context({ deviceId: 'device-b' }),
        ),
      () =>
        applySyncV2PushResponse(
          current,
          request([sent]),
          validResponse,
          context({ detectedAt: '' }),
        ),
    ];

    for (const apply of cases) expect(apply).toThrow(SyncProtocolError);
  });

  it('does not apply a response while the durable replica is held by a sync issue', () => {
    const sent = mutation('op-held', 'upsert', noteA);
    const current = replica({
      sent: [sent],
      resources: { [noteA]: localProjection(sent) },
      syncIssue: {
        code: 'invalid_sync_response',
        message: 'Review this held request before retrying.',
        affectedOpIds: [sent.opId],
        recoveryKind: 'retry',
      },
    });

    expect(() =>
      applySyncV2PushResponse(
        current,
        request([sent]),
        response({ applied: [applied(sent, resource(noteA, { version: 2 }))] }),
        context(),
      ),
    ).toThrow(SyncProtocolError);
  });

  it('does not mutate any input or clear pending work when complete validation fails', () => {
    const first = mutation('op-atomic-first', 'upsert', noteA);
    const second = mutation('op-atomic-second', 'upsert', noteB);
    const current = replica({
      sent: [first, second],
      resources: {
        [noteA]: localProjection(first),
        [noteB]: localProjection(second),
      },
    });
    const dispatched = request([first, second]);
    const invalidResponse = response({
      applied: [
        applied(first, resource(noteA, { version: 2 })),
        applied(second, resource(noteB, { workspaceId: otherWorkspaceId, version: 2 })),
      ],
    });
    const beforeCurrent = clone(current);
    const beforeRequest = clone(dispatched);
    const beforeResponse = clone(invalidResponse);
    deepFreeze(current);
    deepFreeze(dispatched);
    deepFreeze(invalidResponse);

    expect(() => applySyncV2PushResponse(current, dispatched, invalidResponse, context())).toThrow(
      SyncProtocolError,
    );
    expect(current).toEqual(beforeCurrent);
    expect(current.pendingPush).toEqual(request([first, second]));
    expect(dispatched).toEqual(beforeRequest);
    expect(invalidResponse).toEqual(beforeResponse);
  });

  it('rejects an invalid root before response application', () => {
    const sent = mutation('op-unbacked', 'upsert', noteA);
    const empty = createEmptySyncV2Replica({ userId, workspaceId, deviceId });
    const invalid = {
      ...empty,
      outbox: [sent],
      pendingPush: request([sent]),
    };

    expect(() =>
      applySyncV2PushResponse(
        invalid,
        request([sent]),
        response({ applied: [applied(sent, resource(noteA, { version: 2 }))] }),
        context(),
      ),
    ).toThrow(SyncV2ReplicaIntegrityError);
  });

  it('rejects a root with multiple post-dispatch drafts for one resource', () => {
    const sent = mutation('op-staged-many', 'upsert', noteA);
    const firstNewer = {
      ...mutation('op-newer-one', 'upsert', noteA, { bodyMd: 'First newer draft' }),
      baseVersion: 1,
    };
    const secondNewer = {
      ...mutation('op-newer-two', 'upsert', noteA, { bodyMd: 'Second newer draft' }),
      baseVersion: 1,
    };
    const empty = createEmptySyncV2Replica({ userId, workspaceId, deviceId });
    const invalid = {
      ...empty,
      resources: { [noteA]: resource(noteA, { ...secondNewer.resource.data }) },
      outbox: [firstNewer, secondNewer],
      pendingPush: request([sent]),
    };

    expect(() => validatePersistedSyncV2Replica(invalid)).toThrow(SyncV2ReplicaIntegrityError);
  });
});
