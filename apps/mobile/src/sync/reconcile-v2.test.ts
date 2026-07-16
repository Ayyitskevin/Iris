import { describe, expect, it } from 'vitest';
import {
  SYNC_V2_RESOURCE_SET,
  SyncV2PushRequest as SyncV2PushRequestSchema,
  SyncV2PushResponse as SyncV2PushResponseSchema,
  type SyncV2Mutation,
  type SyncV2NoteResource,
  type SyncV2PushRequest,
  type SyncV2PushResponse,
} from '@iris/shared';

import { correlateSyncV2PushResults } from './reconcile-v2';

const workspaceId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const canonicalWorkspaceId = workspaceId.toLowerCase();
const otherWorkspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const noteA = '11111111-1111-4111-8111-111111111111';
const noteB = '22222222-2222-4222-8222-222222222222';
const noteC = '33333333-3333-4333-8333-333333333333';

function mutation(opId: string, type: SyncV2Mutation['type'], id: string): SyncV2Mutation {
  return {
    opId,
    type,
    resource: {
      type: 'note',
      id,
      data: {
        title: `Title ${opId}`,
        bodyMd: `Body ${opId}`,
        folder: null,
        tags: [],
      },
    },
    baseVersion: type === 'upsert' ? 0 : 1,
  };
}

function resource(
  id: string,
  deletedAt: string | null = null,
  owner = canonicalWorkspaceId,
): SyncV2NoteResource {
  return {
    type: 'note',
    id,
    data: {
      workspaceId: owner,
      title: 'Authoritative',
      bodyMd: 'Server body',
      folder: null,
      tags: [],
      version: 2,
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:01:00.000Z',
      deletedAt,
    },
  };
}

function request(mutations: SyncV2Mutation[]): SyncV2PushRequest {
  return {
    resourceSet: SYNC_V2_RESOURCE_SET,
    deviceId: 'device-a',
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

function applied(mutation: SyncV2Mutation, authoritative?: SyncV2NoteResource) {
  return {
    opId: mutation.opId,
    resource: authoritative,
  };
}

function conflict(mutation: SyncV2Mutation, authoritative: SyncV2NoteResource) {
  return {
    opId: mutation.opId,
    reason: 'version_mismatch' as const,
    serverResource: authoritative,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

describe('Sync v2 request-aware result correlation', () => {
  it('returns request order across reordered result buckets and repeated resource ids', () => {
    const upsert = mutation('op-upsert', 'upsert', noteA);
    const deletion = mutation('op-delete', 'delete', noteA);
    const resurrection = mutation('op-resurrect', 'resurrect', noteC);
    const sent = request([upsert, deletion, resurrection]);
    const upsertResult = applied(upsert, resource(noteA));
    const deleteConflict = conflict(deletion, resource(noteA));
    const resurrectionConflict = conflict(
      resurrection,
      resource(noteC, '2026-07-16T12:00:00.000Z'),
    );

    const correlated = correlateSyncV2PushResults(
      workspaceId,
      sent,
      response({
        applied: [upsertResult],
        conflicts: [resurrectionConflict, deleteConflict],
      }),
    );

    expect(correlated.map((item) => [item.kind, item.operationIndex, item.operation.opId])).toEqual(
      [
        ['applied', 0, 'op-upsert'],
        ['conflict', 1, 'op-delete'],
        ['conflict', 2, 'op-resurrect'],
      ],
    );
    expect(correlated[0]?.result).toEqual(upsertResult);
    expect(correlated[0]?.result).not.toBe(upsertResult);
    expect(correlated[1]?.result).toEqual(deleteConflict);
    expect(correlated[1]?.result).not.toBe(deleteConflict);
  });

  it('accepts an empty exact request and response', () => {
    expect(correlateSyncV2PushResults(workspaceId, request([]), response())).toEqual([]);
  });

  it('composes after the strict shared request and response parsers', () => {
    const upsert = mutation('op-parsed', 'upsert', noteA);
    const parsedRequest = SyncV2PushRequestSchema.parse(request([upsert]));
    const parsedResponse = SyncV2PushResponseSchema.parse(
      response({ applied: [applied(upsert, resource(noteA))] }),
    );

    expect(correlateSyncV2PushResults(workspaceId, parsedRequest, parsedResponse)).toMatchObject([
      {
        kind: 'applied',
        operationIndex: 0,
        operation: { opId: 'op-parsed', resource: { id: noteA } },
        result: { opId: 'op-parsed', resource: { id: noteA } },
      },
    ]);
  });

  it('rejects duplicate submitted operation ids', () => {
    const first = mutation('duplicate', 'upsert', noteA);
    const second = mutation('duplicate', 'upsert', noteB);

    expect(() =>
      correlateSyncV2PushResults(
        workspaceId,
        request([first, second]),
        response({ applied: [applied(first, resource(noteA))] }),
      ),
    ).toThrow('duplicate operation id');
  });

  it('rejects duplicate, unknown, and omitted response results', () => {
    const first = mutation('op-first', 'upsert', noteA);
    const second = mutation('op-second', 'upsert', noteB);
    const firstApplied = applied(first, resource(noteA));

    const invalidResponses: Array<[SyncV2PushResponse, string]> = [
      [response({ applied: [firstApplied, firstApplied] }), 'repeated an operation result'],
      [
        response({
          applied: [firstApplied],
          conflicts: [conflict(first, resource(noteA))],
        }),
        'repeated an operation result',
      ],
      [
        response({
          applied: [
            {
              ...firstApplied,
              opId: 'unknown-operation',
            },
          ],
        }),
        'unknown operation',
      ],
      [response({ applied: [firstApplied] }), 'omitted an operation result'],
    ];

    for (const [invalid, message] of invalidResponses) {
      expect(() =>
        correlateSyncV2PushResults(workspaceId, request([first, second]), invalid),
      ).toThrow(message);
    }
  });

  it('binds resource set, type, id, and workspace on applied and conflict results', () => {
    const upsert = mutation('op-upsert', 'upsert', noteA);
    const validApplied = applied(upsert, resource(noteA));
    const validConflict = conflict(upsert, resource(noteA));

    const cases: Array<[SyncV2PushResponse, string]> = [
      [
        {
          ...response({ applied: [validApplied] }),
          resourceSet: 'future-v1',
        } as unknown as SyncV2PushResponse,
        'resource set',
      ],
      [
        response({
          applied: [
            {
              ...validApplied,
              resource: {
                ...resource(noteA),
                type: 'project',
              } as unknown as SyncV2NoteResource,
            },
          ],
        }),
        'resource type',
      ],
      [response({ applied: [applied(upsert, resource(noteB))] }), 'resource id'],
      [
        response({
          applied: [applied(upsert, resource(noteA, null, otherWorkspaceId))],
        }),
        'another workspace',
      ],
      [
        response({
          conflicts: [
            {
              ...validConflict,
              serverResource: {
                ...resource(noteA),
                type: 'project',
              } as unknown as SyncV2NoteResource,
            },
          ],
        }),
        'resource type',
      ],
      [
        response({
          conflicts: [
            {
              ...validConflict,
              serverResource: resource(noteB),
            },
          ],
        }),
        'resource id',
      ],
      [
        response({
          conflicts: [conflict(upsert, resource(noteA, null, otherWorkspaceId))],
        }),
        'another workspace',
      ],
    ];

    for (const [invalid, message] of cases) {
      expect(() => correlateSyncV2PushResults(workspaceId, request([upsert]), invalid)).toThrow(
        message,
      );
    }

    const futureRequest = {
      ...request([upsert]),
      resourceSet: 'future-v1',
    } as unknown as SyncV2PushRequest;
    const futureResponse = {
      ...response({ applied: [validApplied] }),
      resourceSet: 'future-v1',
    } as unknown as SyncV2PushResponse;
    expect(() => correlateSyncV2PushResults(workspaceId, futureRequest, futureResponse)).toThrow(
      'resource set',
    );
  });

  it('treats operation ids as case-sensitive', () => {
    const upsert = mutation('Case-Sensitive', 'upsert', noteA);
    expect(() =>
      correlateSyncV2PushResults(
        workspaceId,
        request([upsert]),
        response({
          applied: [{ ...applied(upsert, resource(noteA)), opId: 'case-sensitive' }],
        }),
      ),
    ).toThrow('unknown operation');
  });

  it('returns a deeply frozen operation snapshot detached from the mutable request', () => {
    const upsert = mutation('op-detached', 'upsert', noteA);
    const sent = request([upsert]);
    const before = JSON.stringify(sent);
    const [correlated] = correlateSyncV2PushResults(
      workspaceId,
      sent,
      response({ applied: [applied(upsert, resource(noteA))] }),
    );
    expect(JSON.stringify(sent)).toBe(before);
    upsert.opId = 'changed-after-correlation';
    upsert.type = 'delete';
    upsert.resource.id = noteB;
    upsert.resource.data.title = 'Changed title';
    upsert.resource.data.tags.push('late-change');

    expect(correlated?.operation).toMatchObject({
      opId: 'op-detached',
      type: 'upsert',
      resource: { id: noteA, data: { title: 'Title op-detached', tags: [] } },
    });
    expect(Object.isFrozen(correlated)).toBe(true);
    expect(Object.isFrozen(correlated?.operation)).toBe(true);
    expect(Object.isFrozen(correlated?.operation.resource)).toBe(true);
    expect(Object.isFrozen(correlated?.operation.resource.data)).toBe(true);
    expect(Object.isFrozen(correlated?.operation.resource.data.tags)).toBe(true);
  });

  it('returns deeply frozen result snapshots detached from the parsed response', () => {
    const upsert = mutation('op-snapshot', 'upsert', noteA);
    const serverResource = resource(noteA);
    const deletion = mutation('op-conflict-snapshot', 'delete', noteB);
    const conflictResource = resource(noteB);
    const parsedResponse = response({
      applied: [applied(upsert, serverResource)],
      conflicts: [conflict(deletion, conflictResource)],
    });
    const [appliedSnapshot, conflictSnapshot] = correlateSyncV2PushResults(
      workspaceId,
      request([upsert, deletion]),
      parsedResponse,
    );

    serverResource.data.title = 'Changed after correlation';
    serverResource.data.tags.push('late-change');
    conflictResource.data.title = 'Changed conflict after correlation';
    conflictResource.data.tags.push('late-conflict-change');

    expect(appliedSnapshot?.kind).toBe('applied');
    if (!appliedSnapshot || appliedSnapshot.kind !== 'applied') {
      throw new Error('Expected applied result');
    }
    expect(appliedSnapshot.result.resource?.data.title).toBe('Authoritative');
    expect(appliedSnapshot.result.resource?.data.tags).toEqual([]);
    expect(Object.isFrozen(appliedSnapshot)).toBe(true);
    expect(Object.isFrozen(appliedSnapshot.result)).toBe(true);
    expect(Object.isFrozen(appliedSnapshot.result.resource)).toBe(true);
    expect(Object.isFrozen(appliedSnapshot.result.resource?.data)).toBe(true);
    expect(Object.isFrozen(appliedSnapshot.result.resource?.data.tags)).toBe(true);

    expect(conflictSnapshot?.kind).toBe('conflict');
    if (!conflictSnapshot || conflictSnapshot.kind !== 'conflict') {
      throw new Error('Expected conflict result');
    }
    expect(conflictSnapshot.result.serverResource.data.title).toBe('Authoritative');
    expect(conflictSnapshot.result.serverResource.data.tags).toEqual([]);
    expect(Object.isFrozen(conflictSnapshot)).toBe(true);
    expect(Object.isFrozen(conflictSnapshot.result)).toBe(true);
    expect(Object.isFrozen(conflictSnapshot.result.serverResource)).toBe(true);
    expect(Object.isFrozen(conflictSnapshot.result.serverResource.data)).toBe(true);
    expect(Object.isFrozen(conflictSnapshot.result.serverResource.data.tags)).toBe(true);
  });

  it('accepts only lifecycle-coherent applied results', () => {
    const upsert = mutation('op-upsert', 'upsert', noteA);
    const resurrection = mutation('op-resurrect', 'resurrect', noteB);
    const deletion = mutation('op-delete', 'delete', noteC);
    const tombstone = resource(noteC, '2026-07-16T12:00:00.000Z');

    expect(
      correlateSyncV2PushResults(
        workspaceId,
        request([upsert, resurrection, deletion]),
        response({
          applied: [
            applied(deletion, tombstone),
            applied(resurrection, resource(noteB)),
            applied(upsert, resource(noteA)),
          ],
        }),
      ),
    ).toHaveLength(3);
    expect(
      correlateSyncV2PushResults(
        workspaceId,
        request([deletion]),
        response({ applied: [applied(deletion)] }),
      ),
    ).toHaveLength(1);

    const invalid: Array<[SyncV2Mutation, SyncV2PushResponse, string]> = [
      [upsert, response({ applied: [applied(upsert)] }), 'omitted its resource'],
      [
        upsert,
        response({
          applied: [applied(upsert, resource(noteA, '2026-07-16T12:00:00.000Z'))],
        }),
        'returned a tombstone',
      ],
      [resurrection, response({ applied: [applied(resurrection)] }), 'omitted its resource'],
      [
        resurrection,
        response({
          applied: [applied(resurrection, resource(noteB, '2026-07-16T12:00:00.000Z'))],
        }),
        'returned a tombstone',
      ],
      [
        deletion,
        response({ applied: [applied(deletion, resource(noteC))] }),
        'returned a live resource',
      ],
    ];

    for (const [sent, invalidResponse, message] of invalid) {
      expect(() =>
        correlateSyncV2PushResults(workspaceId, request([sent]), invalidResponse),
      ).toThrow(message);
    }
  });

  it('accepts only lifecycle-coherent conflicts', () => {
    const upsert = mutation('op-upsert', 'upsert', noteA);
    const resurrection = mutation('op-resurrect', 'resurrect', noteB);
    const deletion = mutation('op-delete', 'delete', noteC);
    const deletedAt = '2026-07-16T12:00:00.000Z';

    const valid = [
      [upsert, resource(noteA)],
      [upsert, resource(noteA, deletedAt)],
      [resurrection, resource(noteB)],
      [resurrection, resource(noteB, deletedAt)],
      [deletion, resource(noteC)],
    ] as const;
    for (const [sent, authoritative] of valid) {
      expect(
        correlateSyncV2PushResults(
          workspaceId,
          request([sent]),
          response({ conflicts: [conflict(sent, authoritative)] }),
        ),
      ).toHaveLength(1);
    }

    expect(() =>
      correlateSyncV2PushResults(
        workspaceId,
        request([deletion]),
        response({
          conflicts: [conflict(deletion, resource(noteC, deletedAt))],
        }),
      ),
    ).toThrow('delete conflict returned a tombstone');
  });

  it('compares UUIDs canonically without mutating a frozen supplied request', () => {
    const uppercaseId = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
    const upsert = mutation('op-uppercase', 'upsert', uppercaseId);
    const sent = deepFreeze(request([upsert]));
    const before = JSON.stringify(sent);
    const valid = response({
      applied: [applied(upsert, resource(uppercaseId.toLowerCase()))],
    });

    const first = correlateSyncV2PushResults(workspaceId, sent, valid);
    const second = correlateSyncV2PushResults(workspaceId, sent, valid);
    expect(first).toEqual(second);
    expect(JSON.stringify(sent)).toBe(before);

    expect(() => correlateSyncV2PushResults(workspaceId, sent, response({ applied: [] }))).toThrow(
      'omitted an operation result',
    );
    expect(JSON.stringify(sent)).toBe(before);
  });
});
