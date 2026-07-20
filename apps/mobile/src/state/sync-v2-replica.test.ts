import {
  SYNC_V2_RESOURCE_SET,
  type SyncV2Mutation,
  type SyncV2NoteResource,
  type SyncV2PushRequest,
} from '@iris/shared';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./storage', () => ({
  storage: {
    get: async () => null,
    set: async () => undefined,
    remove: async () => undefined,
  },
}));

import {
  SYNC_V2_REPLICA_VERSION,
  SyncV2ReplicaIntegrityError,
  createEmptySyncV2Replica,
  parsePersistedSyncV2Replica,
  serializePersistedSyncV2Replica,
  validatePersistedSyncV2Replica,
  type PersistedSyncV2Replica,
  type SyncV2ConflictDraft,
  type SyncV2Issue,
} from './sync-v2-replica';
import {
  TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
  TransactionalOwnerReplicaRepository,
  type CompareAndSwapResult,
  type TransactionalReplicaRecord,
  type TransactionalReplicaStore,
} from './transactional-replica-repository';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherWorkspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherUserId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const noteA = '11111111-1111-4111-8111-111111111111';
const noteB = '22222222-2222-4222-8222-222222222222';
const noteWithLetters = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const deviceId = 'device-a';
const detectedAt = '2026-07-16T18:30:00.000Z';

function resource(id = noteA, owner = workspaceId, title = `Server ${id}`): SyncV2NoteResource {
  return {
    type: 'note',
    id,
    data: {
      workspaceId: owner,
      title,
      bodyMd: `Body ${id}`,
      folder: null,
      tags: ['durable'],
      version: 2,
      createdAt: '2026-07-16T18:00:00.000Z',
      updatedAt: '2026-07-16T18:01:00.000Z',
      deletedAt: null,
    },
  };
}

function mutation(
  opId = 'op-a',
  id = noteA,
  type: SyncV2Mutation['type'] = 'upsert',
): SyncV2Mutation {
  return {
    opId,
    type,
    resource: {
      type: 'note',
      id,
      data: {
        title: `Local ${opId}`,
        bodyMd: `Draft ${opId}`,
        folder: null,
        tags: ['local'],
      },
    },
    baseVersion: type === 'upsert' ? 0 : 2,
  };
}

function projectedResource(queued: SyncV2Mutation, owner = workspaceId): SyncV2NoteResource {
  return {
    type: 'note',
    id: queued.resource.id,
    data: {
      workspaceId: owner,
      title: queued.resource.data.title,
      bodyMd: queued.resource.data.bodyMd,
      folder: queued.resource.data.folder,
      tags: [...queued.resource.data.tags],
      version: queued.baseVersion,
      createdAt: '2026-07-16T18:00:00.000Z',
      updatedAt: '2026-07-16T18:01:00.000Z',
      deletedAt: queued.type === 'delete' ? detectedAt : null,
    },
  };
}

function pushRequest(mutations: SyncV2Mutation[], requestDeviceId = deviceId): SyncV2PushRequest {
  return {
    resourceSet: SYNC_V2_RESOURCE_SET,
    deviceId: requestDeviceId,
    mutations,
  };
}

function issue(recoveryKind: SyncV2Issue['recoveryKind'] = 'retry'): SyncV2Issue {
  return {
    code: 'sync_retry_required',
    message: 'Retry the exact durable request.',
    affectedOpIds: ['op-a'],
    recoveryKind,
  };
}

function conflict(
  authoritative = resource(noteB),
  localMutation = mutation('op-conflict', authoritative.id),
): SyncV2ConflictDraft {
  return {
    localMutation,
    serverResource: authoritative,
    detectedAt,
  };
}

function replica(overrides: Partial<PersistedSyncV2Replica> = {}): PersistedSyncV2Replica {
  return {
    version: SYNC_V2_REPLICA_VERSION,
    ownerKey: `${workspaceId}.${userId}`,
    userId,
    workspaceId,
    deviceId,
    resourceSet: SYNC_V2_RESOURCE_SET,
    cursor: '',
    resources: {},
    outbox: [],
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
    ...overrides,
  };
}

function populatedReplica(): PersistedSyncV2Replica {
  const queued = mutation('op-a', noteA);
  const authoritativeConflict = resource(noteB);
  return replica({
    cursor: `resource-v1:notes-v1:${workspaceId}:42`,
    resources: {
      [noteA]: projectedResource(queued),
      [noteB]: authoritativeConflict,
    },
    outbox: [queued],
    pendingPush: pushRequest([queued]),
    syncIssue: issue(),
    conflicts: {
      [noteB]: conflict(authoritativeConflict),
    },
  });
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectIntegrityError(candidate: unknown, message: string): void {
  expect(() => validatePersistedSyncV2Replica(candidate)).toThrow(SyncV2ReplicaIntegrityError);
  expect(() => validatePersistedSyncV2Replica(candidate)).toThrow(message);
}

class MemoryTransactionalStore implements TransactionalReplicaStore {
  readonly records = new Map<string, TransactionalReplicaRecord>();

  async read(ownerKey: string): Promise<TransactionalReplicaRecord | null> {
    return this.records.get(ownerKey) ?? null;
  }

  async compareAndSwap(
    ownerKey: string,
    expectedRevision: number,
    serializedReplica: string,
  ): Promise<CompareAndSwapResult> {
    const current = this.records.get(ownerKey) ?? null;
    if ((current?.revision ?? 0) !== expectedRevision) {
      return { status: 'conflict', record: current };
    }
    const record: TransactionalReplicaRecord = {
      schemaVersion: TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
      ownerKey,
      revision: expectedRevision + 1,
      serializedReplica,
    };
    this.records.set(ownerKey, record);
    return { status: 'committed', record };
  }

  async erase(ownerKey: string): Promise<void> {
    this.records.delete(ownerKey);
  }
}

describe('Sync v2 persisted replica', () => {
  describe('creation, serialization, and transactional persistence', () => {
    it('creates an exact empty owner root without sharing mutable containers', () => {
      const first = createEmptySyncV2Replica({ userId, workspaceId, deviceId });
      const second = createEmptySyncV2Replica({ userId, workspaceId, deviceId });

      expect(first).toEqual(replica());
      expect(first).not.toBe(second);
      expect(first.resources).not.toBe(second.resources);
      expect(first.outbox).not.toBe(second.outbox);
      expect(first.conflicts).not.toBe(second.conflicts);
    });

    it('rejects invalid owner and device inputs while creating an empty root', () => {
      expect(() =>
        createEmptySyncV2Replica({ userId: 'not-a-uuid', workspaceId, deviceId }),
      ).toThrow('user id');
      expect(() =>
        createEmptySyncV2Replica({ userId, workspaceId: 'not-a-uuid', deviceId }),
      ).toThrow('workspace id');
      expect(() => createEmptySyncV2Replica({ userId, workspaceId, deviceId: '' })).toThrow(
        'device id',
      );
    });

    it('round-trips a fully populated root and rejects invalid JSON', () => {
      const expected = populatedReplica();
      const serialized = serializePersistedSyncV2Replica(expected);
      const parsed = parsePersistedSyncV2Replica(serialized);

      expect(parsed).toEqual(expected);
      expect(serializePersistedSyncV2Replica(parsed)).toBe(serialized);
      expect(() => parsePersistedSyncV2Replica('{')).toThrow(SyncV2ReplicaIntegrityError);
      expect(() => parsePersistedSyncV2Replica('{')).toThrow('not valid JSON');
      expect(() => parsePersistedSyncV2Replica('{}')).toThrow('root is invalid');
    });

    it('detaches every mutable nested value from the validated input', () => {
      const input = populatedReplica();
      const validated = validatePersistedSyncV2Replica(input);

      expect(validated).not.toBe(input);
      expect(validated.resources).not.toBe(input.resources);
      expect(validated.resources[noteA]).not.toBe(input.resources[noteA]);
      expect(validated.outbox).not.toBe(input.outbox);
      expect(validated.outbox[0]).not.toBe(input.outbox[0]);
      expect(validated.pendingPush).not.toBe(input.pendingPush);
      expect(validated.syncIssue).not.toBe(input.syncIssue);
      expect(validated.conflicts).not.toBe(input.conflicts);
      expect(validated.conflicts[noteB]).not.toBe(input.conflicts[noteB]);

      input.resources[noteA]!.data.title = 'mutated authoritative input';
      input.outbox[0]!.resource.data.tags.push('mutated outbox input');
      input.pendingPush!.mutations[0]!.resource.data.title = 'mutated pending input';
      input.syncIssue!.affectedOpIds.push('mutated-issue');
      input.conflicts[noteB]!.localMutation.resource.data.bodyMd = 'mutated conflict input';

      expect(validated.resources[noteA]!.data.title).toBe('Local op-a');
      expect(validated.outbox[0]!.resource.data.tags).toEqual(['local']);
      expect(validated.pendingPush!.mutations[0]!.resource.data.title).toBe('Local op-a');
      expect(validated.syncIssue!.affectedOpIds).toEqual(['op-a']);
      expect(validated.conflicts[noteB]!.localMutation.resource.data.bodyMd).toBe(
        'Draft op-conflict',
      );
    });

    it('preserves exact v3 bytes through the transactional repository and restart parse', async () => {
      const expected = populatedReplica();
      const serialized = serializePersistedSyncV2Replica(expected);
      const store = new MemoryTransactionalStore();
      const writer = new TransactionalOwnerReplicaRepository(store);

      await writer.commit(expected.ownerKey, serialized);
      expect(store.records.get(expected.ownerKey)).toEqual({
        schemaVersion: TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
        ownerKey: expected.ownerKey,
        revision: 1,
        serializedReplica: serialized,
      });

      const restarted = new TransactionalOwnerReplicaRepository(store);
      const observed = await restarted.read(expected.ownerKey);
      expect(observed).toBe(serialized);
      expect(parsePersistedSyncV2Replica(observed!)).toEqual(expected);
      expect(serializePersistedSyncV2Replica(parsePersistedSyncV2Replica(observed!))).toBe(
        serialized,
      );
    });
  });

  describe('exact root and owner boundaries', () => {
    it('accepts the complete exact root and rejects missing, extra, or unsupported fields', () => {
      expect(validatePersistedSyncV2Replica(populatedReplica())).toEqual(populatedReplica());

      const missing = jsonClone(replica()) as unknown as Record<string, unknown>;
      delete missing.cursor;
      const cases: Array<[unknown, string]> = [
        [null, 'root is invalid'],
        [[], 'root is invalid'],
        [missing, 'root is invalid'],
        [{ ...replica(), future: true }, 'root is invalid'],
        [{ ...replica(), version: 4 }, 'version is unsupported'],
        [{ ...replica(), resourceSet: 'notes-v2' }, 'resource set is unsupported'],
        [{ ...replica(), userId: 'not-a-uuid' }, 'user id'],
        [{ ...replica(), workspaceId: 'not-a-uuid' }, 'workspace id'],
        [{ ...replica(), deviceId: '' }, 'device id'],
      ];

      for (const [candidate, message] of cases) {
        expectIntegrityError(candidate, message);
      }
    });

    it('requires the exact workspace-user owner key and rejects cross-owner roots', () => {
      const cases: Array<[unknown, string]> = [
        [{ ...replica(), ownerKey: `${workspaceId}.${otherUserId}` }, 'owner key'],
        [{ ...replica(), ownerKey: `${otherWorkspaceId}.${userId}` }, 'owner key'],
        [{ ...replica(), userId: otherUserId }, 'owner key'],
        [{ ...replica(), workspaceId: otherWorkspaceId }, 'owner key'],
      ];

      for (const [candidate, message] of cases) {
        expectIntegrityError(candidate, message);
      }
    });

    it('requires canonical owner routing while comparing embedded UUID identities canonically', () => {
      const upperWorkspace = workspaceId.toUpperCase();
      const upperUser = userId.toUpperCase();
      const upperNote = noteWithLetters.toUpperCase();
      const candidate = replica({
        cursor: `resource-v1:notes-v1:${upperWorkspace}:1`,
        resources: { [noteWithLetters]: resource(upperNote, workspaceId) },
      });

      expect(validatePersistedSyncV2Replica(candidate)).toEqual(candidate);
      expectIntegrityError(
        {
          ...candidate,
          workspaceId: upperWorkspace,
          userId: upperUser,
          ownerKey: `${upperWorkspace}.${upperUser}`,
        },
        'canonical lowercase',
      );
    });
  });

  describe('cursor, resources, and outbox invariants', () => {
    it('accepts an empty or owner-bound canonical cursor and rejects malformed cursors', () => {
      expect(validatePersistedSyncV2Replica(replica()).cursor).toBe('');
      expect(
        validatePersistedSyncV2Replica({
          ...replica(),
          cursor: `resource-v1:notes-v1:${workspaceId}:0`,
        }).cursor,
      ).toBe(`resource-v1:notes-v1:${workspaceId}:0`);

      const invalidCursors: unknown[] = [
        1,
        'x'.repeat(201),
        `resource-v1:notes-v1:${workspaceId}:01`,
        `resource-v1:notes-v1:${workspaceId}:-1`,
        `resource-v1:notes-v2:${workspaceId}:1`,
        `resource-v1:notes-v1:${otherWorkspaceId}:1`,
        'resource-v1:notes-v1:not-a-uuid:1',
        `resource-v1:notes-v1:${workspaceId}:1:extra`,
      ];
      for (const cursor of invalidCursors) {
        expectIntegrityError(
          { ...replica(), cursor },
          typeof cursor === 'string' && cursor.includes(otherWorkspaceId)
            ? 'another workspace'
            : 'cursor',
        );
      }
    });

    it('requires exact owner-bound resources keyed by their UUID identity', () => {
      const valid = replica({ resources: { [noteA]: resource(noteA) } });
      expect(validatePersistedSyncV2Replica(valid)).toEqual(valid);

      const cases: Array<[unknown, string]> = [
        [{ ...replica(), resources: [] }, 'resources must be an object'],
        [{ ...replica(), resources: { 'not-a-uuid': resource(noteA) } }, 'resource key'],
        [
          { ...replica(), resources: { [noteA]: resource(noteB) } },
          'does not match its embedded id',
        ],
        [
          { ...replica(), resources: { [noteA]: resource(noteA, otherWorkspaceId) } },
          'another workspace',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: { ...resource(noteA), future: true } },
          },
          'invalid resource',
        ],
        [
          {
            ...replica(),
            resources: {
              [noteWithLetters]: resource(noteWithLetters),
              [noteWithLetters.toUpperCase()]: resource(noteWithLetters),
            },
          },
          'duplicate resource',
        ],
      ];

      for (const [candidate, message] of cases) {
        expectIntegrityError(candidate, message);
      }
    });

    it('requires every version-zero local projection to retain a current queued draft', () => {
      const unacknowledged = resource(noteA);
      unacknowledged.data.version = 0;
      expectIntegrityError(
        replica({ resources: { [noteA]: unacknowledged } }),
        'version-zero resource has no current queued draft',
      );

      const queued = mutation('op-local-create', noteA);
      expect(
        validatePersistedSyncV2Replica(
          replica({ resources: { [noteA]: projectedResource(queued) }, outbox: [queued] }),
        ).resources[noteA]?.data.version,
      ).toBe(0);
    });

    it('rejects malformed or duplicated outbox operations and missing projections', () => {
      const queued = mutation('op-a', noteA);
      expect(
        validatePersistedSyncV2Replica(
          replica({ resources: { [noteA]: projectedResource(queued) }, outbox: [queued] }),
        ).outbox,
      ).toEqual([queued]);

      const cases: Array<[unknown, string]> = [
        [{ ...replica(), outbox: {} }, 'outbox must be an array'],
        [
          {
            ...replica(),
            resources: { [noteA]: projectedResource(queued) },
            outbox: [{ ...queued, future: true }],
          },
          'invalid outbox mutation',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: projectedResource(queued) },
            outbox: [queued, { ...mutation('op-b', noteA), opId: queued.opId }],
          },
          'duplicate operation id',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: projectedResource(queued) },
            outbox: [queued, mutation('op-b', noteA)],
          },
          'multiple current drafts for one resource',
        ],
        [{ ...replica(), outbox: [queued] }, 'no local resource projection'],
      ];

      for (const [candidate, message] of cases) {
        expectIntegrityError(candidate, message);
      }
    });

    it('binds every outbox draft exactly to its projected bytes, base version, and lifecycle', () => {
      const queued = mutation('op-upsert', noteA);
      const deletion = mutation('op-delete', noteB, 'delete');
      expect(
        validatePersistedSyncV2Replica(
          replica({
            resources: {
              [noteA]: projectedResource(queued),
              [noteB]: projectedResource(deletion),
            },
            outbox: [queued, deletion],
          }),
        ).outbox,
      ).toEqual([queued, deletion]);

      const wrongVersion = projectedResource(queued);
      wrongVersion.data.version += 1;
      const wrongContent = projectedResource(queued);
      wrongContent.data.title = 'not the queued title';
      const wrongLifecycle = projectedResource(deletion);
      wrongLifecycle.data.deletedAt = null;
      const cases: Array<[SyncV2Mutation, SyncV2NoteResource, string]> = [
        [queued, wrongVersion, 'does not match its local resource projection'],
        [queued, wrongContent, 'does not match its local resource projection'],
        [deletion, wrongLifecycle, 'lifecycle does not match'],
      ];
      for (const [draft, projection, message] of cases) {
        expectIntegrityError(
          replica({ resources: { [draft.resource.id]: projection }, outbox: [draft] }),
          message,
        );
      }
    });
  });

  describe('pending request invariants', () => {
    it('accepts an exact pending request and a later queued edit for the same resource', () => {
      const dispatched = mutation('op-dispatched', noteA);
      const later = mutation('op-later', noteA);
      const candidate = replica({
        resources: { [noteA]: projectedResource(later) },
        outbox: [later],
        pendingPush: pushRequest([dispatched]),
      });

      expect(validatePersistedSyncV2Replica(candidate)).toEqual(candidate);
    });

    it('rejects empty, foreign-device, widened, duplicated, and unqueued pending requests', () => {
      const queued = mutation('op-a', noteA);
      const base = replica({
        resources: {
          [noteA]: projectedResource(queued),
          [noteB]: resource(noteB),
        },
        outbox: [queued],
      });
      const cases: Array<[unknown, string]> = [
        [{ ...base, pendingPush: pushRequest([]) }, 'cannot be empty'],
        [{ ...base, pendingPush: pushRequest([queued], 'device-b') }, 'wrong device id'],
        [
          { ...base, pendingPush: { ...pushRequest([queued]), future: true } },
          'pending request is invalid',
        ],
        [
          { ...base, pendingPush: pushRequest([queued, jsonClone(queued)]) },
          'pending request is invalid',
        ],
        [
          { ...base, pendingPush: pushRequest([mutation('op-b', noteB)]) },
          'no queued operation for its resource',
        ],
      ];

      for (const [candidate, message] of cases) {
        expectIntegrityError(candidate, message);
      }
    });

    it('rejects operation-id reuse with a different durable payload', () => {
      const queued = mutation('op-a', noteA);
      const changed = jsonClone(queued);
      changed.resource.data.title = 'different payload';
      expectIntegrityError(
        replica({
          resources: { [noteA]: projectedResource(queued) },
          outbox: [queued],
          pendingPush: pushRequest([changed]),
        }),
        'different queued payload',
      );
    });

    it('requires a queued operation retained in pending work to represent its final resource operation', () => {
      const queued = mutation('op-current', noteA);
      const laterPending = mutation('op-later-pending', noteA);
      expectIntegrityError(
        replica({
          resources: { [noteA]: projectedResource(queued) },
          outbox: [queued],
          pendingPush: pushRequest([queued, laterPending]),
        }),
        'final pending resource operation',
      );
    });
  });

  describe('durable issue and conflict invariants', () => {
    it('accepts every recovery kind and detaches affected operation ids', () => {
      const recoveryKinds: SyncV2Issue['recoveryKind'][] = [
        'rekey',
        'reset-cursor',
        'restage',
        'retry',
      ];
      for (const recoveryKind of recoveryKinds) {
        const input = issue(recoveryKind);
        const validated = validatePersistedSyncV2Replica(replica({ syncIssue: input }));
        expect(validated.syncIssue).toEqual(input);
        expect(validated.syncIssue).not.toBe(input);
        expect(validated.syncIssue!.affectedOpIds).not.toBe(input.affectedOpIds);
      }
    });

    it('rejects widened, empty, duplicated, or unknown durable issue fields', () => {
      const base = issue();
      const sparseOperationIds = new Array<string>(1);
      const invalidIssues: unknown[] = [
        [],
        { ...base, future: true },
        { ...base, code: '' },
        { ...base, message: '' },
        { ...base, affectedOpIds: [''] },
        { ...base, affectedOpIds: ['x'.repeat(201)] },
        { ...base, affectedOpIds: ['op-a\u0000'] },
        { ...base, affectedOpIds: sparseOperationIds },
        { ...base, affectedOpIds: ['op-a', 'op-a'] },
        { ...base, recoveryKind: 'future-recovery' },
        { ...base, recoveryKind: { toString: () => 'retry' } },
      ];

      for (const syncIssue of invalidIssues) {
        expectIntegrityError({ ...replica(), syncIssue }, 'issue');
      }
    });

    it('accepts an exact conflict whose authoritative resource is the projection', () => {
      const authoritative = resource(noteA);
      const draft = conflict(authoritative, mutation('op-conflict', noteA, 'delete'));
      const candidate = replica({
        resources: { [noteA]: authoritative },
        conflicts: { [noteA]: draft },
      });

      expect(validatePersistedSyncV2Replica(candidate)).toEqual(candidate);
    });

    it('rejects malformed, cross-owner, mismatched, or unprojected conflicts', () => {
      const authoritative = resource(noteA);
      const baseConflict = conflict(authoritative);
      const tombstone = resource(noteA);
      tombstone.data.deletedAt = detectedAt;
      const versionZero = resource(noteA);
      versionZero.data.version = 0;
      const cases: Array<[unknown, string]> = [
        [{ ...replica(), conflicts: [] }, 'conflicts must be an object'],
        [
          {
            ...replica(),
            resources: { [noteA]: authoritative },
            conflicts: { [noteA]: { ...baseConflict, future: true } },
          },
          'invalid conflict',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: authoritative },
            conflicts: { [noteA]: { ...baseConflict, detectedAt: 42 } },
          },
          'invalid conflict',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: authoritative },
            conflicts: { [noteA]: { ...baseConflict, detectedAt: '' } },
          },
          'invalid conflict',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: authoritative },
            conflicts: {
              [noteA]: { ...baseConflict, localMutation: mutation('op-x', noteB) },
            },
          },
          'identity or workspace',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: authoritative },
            conflicts: {
              [noteA]: { ...baseConflict, serverResource: resource(noteB) },
            },
          },
          'identity or workspace',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: authoritative },
            conflicts: {
              [noteA]: {
                ...baseConflict,
                serverResource: resource(noteA, otherWorkspaceId),
              },
            },
          },
          'identity or workspace',
        ],
        [
          { ...replica(), conflicts: { [noteA]: baseConflict } },
          'does not match the local projection',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: resource(noteA, workspaceId, 'different projection') },
            conflicts: { [noteA]: baseConflict },
          },
          'does not match the local projection',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: tombstone },
            conflicts: {
              [noteA]: conflict(tombstone, mutation('op-delete-conflict', noteA, 'delete')),
            },
          },
          'authoritative lifecycle or version',
        ],
        [
          {
            ...replica(),
            resources: { [noteA]: versionZero },
            conflicts: { [noteA]: conflict(versionZero) },
          },
          'authoritative lifecycle or version',
        ],
      ];

      for (const [candidate, message] of cases) {
        expectIntegrityError(candidate, message);
      }
    });

    it('rejects canonical duplicate conflict identities and queued-conflicted resources', () => {
      const authoritative = resource(noteWithLetters);
      const baseConflict = conflict(authoritative);
      expectIntegrityError(
        replica({
          resources: { [noteWithLetters]: authoritative },
          conflicts: {
            [noteWithLetters]: baseConflict,
            [noteWithLetters.toUpperCase()]: jsonClone(baseConflict),
          },
        }),
        'duplicate conflict',
      );

      const queued = { ...mutation('op-queued', noteA), baseVersion: 1 };
      const sharedProjection = projectedResource(queued);
      expectIntegrityError(
        replica({
          resources: { [noteA]: sharedProjection },
          outbox: [queued],
          conflicts: { [noteA]: conflict(sharedProjection) },
        }),
        'both queued and conflicted',
      );
    });

    it('rejects conflict operation ids reused by queued or pending work', () => {
      const queued = mutation('op-active', noteA);
      const authoritativeConflict = resource(noteB);
      const collidingConflict = conflict(authoritativeConflict, mutation(queued.opId, noteB));
      expectIntegrityError(
        replica({
          resources: {
            [noteA]: projectedResource(queued),
            [noteB]: authoritativeConflict,
          },
          outbox: [queued],
          conflicts: { [noteB]: collidingConflict },
        }),
        'reuses an active operation id',
      );

      const dispatched = mutation('op-dispatched', noteA);
      const current = mutation('op-current', noteA);
      expectIntegrityError(
        replica({
          resources: {
            [noteA]: projectedResource(current),
            [noteB]: authoritativeConflict,
          },
          outbox: [current],
          pendingPush: pushRequest([dispatched]),
          conflicts: {
            [noteB]: conflict(authoritativeConflict, mutation(dispatched.opId, noteB)),
          },
        }),
        'reuses an active operation id',
      );
    });
  });
});
