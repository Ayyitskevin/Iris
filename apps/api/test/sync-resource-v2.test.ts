import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SYNC_V2_RESOURCE_SET,
  type Note,
  type SyncMutation,
  type SyncV2Mutation,
  type SyncV2NoteResource,
} from '@iris/shared';
import { call, makeApp, signUp, type TestApp } from './helpers';

function mutation(
  opId: string,
  id: string,
  overrides: Partial<SyncV2Mutation> & {
    data?: Partial<SyncV2Mutation['resource']['data']>;
  } = {},
): SyncV2Mutation {
  return {
    opId,
    type: overrides.type ?? 'upsert',
    resource: {
      type: 'note',
      id,
      data: {
        title: 'Offline note',
        bodyMd: 'made offline',
        folder: null,
        tags: [],
        ...overrides.data,
      },
    },
    baseVersion: overrides.baseVersion ?? 0,
  };
}

function legacyMutation(value: SyncV2Mutation): SyncMutation {
  return {
    opId: value.opId,
    type: value.type,
    note: { id: value.resource.id, ...value.resource.data },
    baseVersion: value.baseVersion,
  };
}

function resource(note: Note): SyncV2NoteResource {
  const { id, ...data } = note;
  return { type: 'note', id, data };
}

function changesPath(deviceId: string, cursor = ''): string {
  return `/v2/sync/changes?resourceSet=${SYNC_V2_RESOURCE_SET}&cursor=${encodeURIComponent(cursor)}&deviceId=${encodeURIComponent(deviceId)}`;
}

describe('generic note resource sync v2', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('projects exact receipt-v1 operations and replays applied outcomes across both routes', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Resource client', platform: 'web' },
    });

    const first = mutation(`v2-first-${randomUUID()}`, randomUUID(), {
      data: {
        title: 'Generic create',
        bodyMd: 'exact receipt payload',
        folder: 'inbox',
        tags: ['Local', 'local'],
      },
    });
    const v2First = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [first] },
    });
    expect(v2First.status).toBe(200);
    expect(v2First.json).toMatchObject({
      resourceSet: SYNC_V2_RESOURCE_SET,
      applied: [
        {
          opId: first.opId,
          resource: {
            type: 'note',
            id: first.resource.id,
            data: { title: 'Generic create', tags: ['local'], version: 1 },
          },
        },
      ],
      conflicts: [],
    });

    const appliedNote = {
      id: v2First.json.applied[0].resource.id,
      ...v2First.json.applied[0].resource.data,
    };
    const canonical = JSON.stringify({
      actorType: 'user',
      actorId: user.userId,
      deviceId,
      operation: {
        type: first.type,
        note: legacyMutation(first).note,
        baseVersion: first.baseVersion,
      },
    });
    const receipt = (
      await t.client.query(
        `SELECT receipt_version, request_fingerprint, outcome
         FROM sync_idempotency
         WHERE workspace_id = $1 AND op_id = $2`,
        [user.workspaceId, first.opId],
      )
    ).rows[0] as {
      receipt_version: number;
      request_fingerprint: string;
      outcome: unknown;
    };
    expect(receipt).toEqual({
      receipt_version: 1,
      request_fingerprint: createHash('sha256').update(canonical).digest('hex'),
      outcome: { kind: 'applied', item: { opId: first.opId, note: appliedNote } },
    });

    // Simulate a lost v2 response: the exact v1 retry replays the same frozen receipt.
    const v1Replay = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: { deviceId, mutations: [legacyMutation(first)] },
    });
    expect(v1Replay.status).toBe(200);
    expect(v1Replay.json).toEqual({
      applied: [{ opId: first.opId, note: appliedNote }],
      conflicts: [],
    });

    // Prove the reverse deployment direction with another operation.
    const second = mutation(`v1-first-${randomUUID()}`, randomUUID(), {
      data: { title: 'Legacy route first', bodyMd: 'then generic replay' },
    });
    const v1First = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: { deviceId, mutations: [legacyMutation(second)] },
    });
    expect(v1First.status).toBe(200);
    const v2Replay = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [second] },
    });
    expect(v2Replay.status).toBe(200);
    expect(v2Replay.json).toEqual({
      resourceSet: SYNC_V2_RESOURCE_SET,
      applied: [{ opId: second.opId, resource: resource(v1First.json.applied[0].note) }],
      conflicts: [],
    });

    for (const noteId of [first.resource.id, second.resource.id]) {
      const history = await call(t.app, 'GET', `/v1/notes/${noteId}/versions`, {
        token: user.token,
      });
      expect(history.json.versions).toHaveLength(1);
    }
    const activity = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    expect(
      activity.json.activity.filter((entry: any) =>
        [first.resource.id, second.resource.id].includes(entry.noteId),
      ),
    ).toHaveLength(2);
  });

  it('replays the exact original conflict across routes after the server head moves', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Conflict replay', platform: 'web' },
    });
    const original = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Server head', bodyMd: 'version one' },
      })
    ).json.note as Note;
    const stale = mutation(`resource-conflict-${randomUUID()}`, original.id, {
      data: { title: original.title, bodyMd: 'stale local draft' },
      baseVersion: 0,
    });

    const first = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [stale] },
    });
    expect(first.status).toBe(200);
    expect(first.json.conflicts[0].serverResource).toEqual(resource(original));

    const moved = await call(t.app, 'PATCH', `/v1/notes/${original.id}`, {
      token: user.token,
      body: { bodyMd: 'version two', baseVersion: 1 },
    });
    expect(moved.json.note.version).toBe(2);

    const replay = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: { deviceId, mutations: [legacyMutation(stale)] },
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({
      applied: [],
      conflicts: [{ opId: stale.opId, reason: 'version_mismatch', serverNote: original }],
    });
    const history = await call(t.app, 'GET', `/v1/notes/${original.id}/versions`, {
      token: user.token,
    });
    expect(history.json.versions).toHaveLength(2);
  });

  it('replays a manually frozen pre-generic receipt through the resource route', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Rollback fixture', platform: 'web' },
    });
    const created = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Before', bodyMd: 'one' },
      })
    ).json.note as Note;
    const updated = (
      await call(t.app, 'PATCH', `/v1/notes/${created.id}`, {
        token: user.token,
        body: {
          title: 'After',
          bodyMd: 'two',
          folder: 'archive',
          tags: ['frozen'],
          baseVersion: 1,
        },
      })
    ).json.note as Note;
    const frozen = mutation(`frozen-v1-${randomUUID()}`, updated.id, {
      data: {
        title: updated.title,
        bodyMd: updated.bodyMd,
        folder: updated.folder,
        tags: updated.tags,
      },
      baseVersion: 1,
    });
    const canonical = JSON.stringify({
      actorType: 'user',
      actorId: user.userId,
      deviceId,
      operation: {
        type: frozen.type,
        note: legacyMutation(frozen).note,
        baseVersion: frozen.baseVersion,
      },
    });
    await t.client.query(
      `INSERT INTO sync_idempotency (
         workspace_id, op_id, actor_type, actor_id, device_id,
         receipt_version, request_fingerprint, outcome
       ) VALUES ($1, $2, 'user', $3, $4, 1, $5, $6::jsonb)`,
      [
        user.workspaceId,
        frozen.opId,
        user.userId,
        deviceId,
        createHash('sha256').update(canonical).digest('hex'),
        JSON.stringify({ kind: 'applied', item: { opId: frozen.opId, note: updated } }),
      ],
    );

    const replay = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [frozen] },
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({
      resourceSet: SYNC_V2_RESOURCE_SET,
      applied: [{ opId: frozen.opId, resource: resource(updated) }],
      conflicts: [],
    });
    const history = await call(t.app, 'GET', `/v1/notes/${updated.id}/versions`, {
      token: user.token,
    });
    expect(history.json.versions).toHaveLength(2);
  });

  it('projects delete, tombstone conflict, and explicit resurrection without changing lifecycle semantics', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Lifecycle adapter', platform: 'web' },
    });
    const noteId = randomUUID();
    const create = mutation(`lifecycle-create-${randomUUID()}`, noteId, {
      data: { title: 'Lifecycle', bodyMd: 'live draft', folder: 'inbox', tags: ['life'] },
    });
    const created = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [create] },
    });
    expect(created.status).toBe(200);

    const remove = mutation(`lifecycle-delete-${randomUUID()}`, noteId, {
      type: 'delete',
      data: create.resource.data,
      baseVersion: 1,
    });
    const deleted = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [remove] },
    });
    expect(deleted.json.applied[0].resource).toMatchObject({
      id: noteId,
      data: { version: 2, deletedAt: expect.any(String) },
    });

    const hiddenRevival = mutation(`lifecycle-upsert-${randomUUID()}`, noteId, {
      data: { title: 'Must conflict', bodyMd: 'ordinary edit cannot revive' },
      baseVersion: 2,
    });
    const conflict = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: [hiddenRevival],
      },
    });
    expect(conflict.json.conflicts[0].serverResource).toEqual(deleted.json.applied[0].resource);

    const revive = mutation(`lifecycle-resurrect-${randomUUID()}`, noteId, {
      type: 'resurrect',
      data: { title: 'Reviewed revival', bodyMd: 'retained draft', tags: ['restored'] },
      baseVersion: 2,
    });
    const resurrected = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [revive] },
    });
    expect(resurrected.json.applied[0].resource).toMatchObject({
      id: noteId,
      data: { version: 3, deletedAt: null, title: 'Reviewed revival' },
    });

    const history = await call(t.app, 'GET', `/v1/notes/${noteId}/versions`, {
      token: user.token,
    });
    expect(history.json.versions).toHaveLength(3);
    const activity = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    expect(
      activity.json.activity
        .filter((entry: any) => entry.noteId === noteId)
        .map((entry: any) => entry.action)
        .sort(),
    ).toEqual(['note.create', 'note.delete', 'note.restore']);
    const receipts = await t.client.query(
      `SELECT receipt_version FROM sync_idempotency
       WHERE workspace_id = $1 AND op_id = ANY($2::text[])`,
      [user.workspaceId, [create.opId, remove.opId, hiddenRevival.opId, revive.opId]],
    );
    expect(receipts.rows).toHaveLength(4);
    expect(receipts.rows.every((row: any) => row.receipt_version === 1)).toBe(true);
  });

  it('rejects every unknown semantic field before creating a receipt or note', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Strict parser', platform: 'web' },
    });
    const base = mutation('strict-base', randomUUID());
    const requests: unknown[] = [
      { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [base], extra: true },
      {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: [{ ...base, extra: true }],
      },
      {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: [{ ...base, resource: { ...base.resource, extra: true } }],
      },
      {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: [
          {
            ...base,
            resource: {
              ...base.resource,
              data: { ...base.resource.data, behavior: 'unbound' },
            },
          },
        ],
      },
      {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: [
          {
            ...base,
            resource: {
              ...base.resource,
              data: { title: 'Missing explicit tags', bodyMd: '', folder: null },
            },
          },
        ],
      },
      {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: [{ ...base, resource: { ...base.resource, type: 'task' } }],
      },
      { resourceSet: 'workspace-v1', deviceId, mutations: [base] },
      { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [base, base] },
    ];

    for (const body of requests) {
      const response = await call(t.app, 'POST', '/v2/sync/push', { token: user.token, body });
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe('validation_error');
    }

    for (const path of [
      `/v2/sync/changes?cursor=&deviceId=${deviceId}`,
      `/v2/sync/changes?resourceSet=workspace-v1&cursor=&deviceId=${deviceId}`,
      `/v2/sync/changes?resourceSet=${SYNC_V2_RESOURCE_SET}&cursor=&deviceId=${deviceId}&filter=note`,
    ]) {
      const response = await call(t.app, 'GET', path, { token: user.token });
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe('validation_error');
    }

    const receipts = await t.client.query(
      `SELECT op_id FROM sync_idempotency WHERE workspace_id = $1`,
      [user.workspaceId],
    );
    expect(receipts.rows).toEqual([]);
    const notes = await call(t.app, 'GET', '/v1/notes', { token: user.token });
    expect(notes.json.notes).toEqual([]);
  });

  it('binds cursors to route, resource set, and workspace while preserving scopes', async () => {
    const ownerA = await signUp(t.app);
    const ownerB = await signUp(t.app);
    const deviceA = `device-${randomUUID()}`;
    const deviceB = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: ownerA.token,
      body: { id: deviceA, name: 'A', platform: 'web' },
    });
    await call(t.app, 'POST', '/v1/devices', {
      token: ownerB.token,
      body: { id: deviceB, name: 'B', platform: 'web' },
    });
    const noteA = (
      await call(t.app, 'POST', '/v1/notes', {
        token: ownerA.token,
        body: { title: 'Only A', bodyMd: 'tenant A' },
      })
    ).json.note as Note;
    await call(t.app, 'POST', '/v1/notes', {
      token: ownerB.token,
      body: { title: 'Only B', bodyMd: 'tenant B' },
    });

    const pullA = await call(t.app, 'GET', changesPath(deviceA), { token: ownerA.token });
    expect(pullA.status).toBe(200);
    expect(pullA.json).toMatchObject({
      resourceSet: SYNC_V2_RESOURCE_SET,
      resources: [resource(noteA)],
      hasMore: false,
    });
    expect(pullA.json.cursor).toMatch(
      new RegExp(`^resource-v1:notes-v1:${ownerA.workspaceId}:\\d+$`),
    );

    const legacyPull = await call(t.app, 'GET', `/v1/sync/changes?since=&deviceId=${deviceA}`, {
      token: ownerA.token,
    });
    expect(legacyPull.status).toBe(200);
    expect(legacyPull.json.cursor).toMatch(/^v2:/);

    for (const [token, path] of [
      [ownerA.token, changesPath(deviceA, legacyPull.json.cursor)],
      [
        ownerA.token,
        `/v1/sync/changes?since=${encodeURIComponent(pullA.json.cursor)}&deviceId=${deviceA}`,
      ],
      [ownerB.token, changesPath(deviceB, pullA.json.cursor)],
      [
        ownerA.token,
        changesPath(deviceA, `resource-v1:${SYNC_V2_RESOURCE_SET}:${ownerA.workspaceId}:999999`),
      ],
      [ownerA.token, changesPath(deviceA, `resource-v1:workspace-v1:${ownerA.workspaceId}:0`)],
      [ownerA.token, changesPath(deviceA, `2026-01-01T00:00:00.000Z|${randomUUID()}`)],
      [ownerA.token, changesPath(deviceA, 'v2:1')],
      [ownerA.token, changesPath(deviceA, 'resource-v1:notes-v1:not-a-uuid:1')],
      [
        ownerA.token,
        changesPath(deviceA, `resource-v1:${SYNC_V2_RESOURCE_SET}:${ownerA.workspaceId}:01`),
      ],
      [
        ownerA.token,
        changesPath(deviceA, `resource-v1:${SYNC_V2_RESOURCE_SET}:${ownerA.workspaceId}:-1`),
      ],
    ] as const) {
      const rejected = await call(t.app, 'GET', path, { token });
      expect(rejected.status).toBe(400);
      expect(rejected.json.error.code).toBe('invalid_sync_cursor');
    }

    const unknownDevice = await call(t.app, 'GET', changesPath('not-registered'), {
      token: ownerA.token,
    });
    expect(unknownDevice.status).toBe(403);

    const readAgent = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: ownerA.token,
      body: { agentName: 'Reader', scopes: ['notes:read'] },
    });
    const agentPull = await call(t.app, 'GET', changesPath(deviceA), {
      token: readAgent.json.token,
    });
    expect(agentPull.status).toBe(200);
    const agentPush = await call(t.app, 'POST', '/v2/sync/push', {
      token: readAgent.json.token,
      body: {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId: deviceA,
        mutations: [mutation(`agent-write-${randomUUID()}`, randomUUID())],
      },
    });
    expect(agentPush.status).toBe(403);
  });

  it('advances an exhausted immutable set to high water without skipping a later note', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Set cursor', platform: 'web' },
    });
    const first = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Sequence one', bodyMd: 'note' },
      })
    ).json.note as Note;
    const pageOne = await call(t.app, 'GET', changesPath(deviceId), { token: user.token });
    expect(pageOne.json.resources).toEqual([resource(first)]);
    expect(pageOne.json.cursor).toMatch(/:1$/);

    // Model one future resource allocating the shared workspace sequence without adding
    // a note to this immutable set.
    await t.client.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.current_workspace', $1, true)`, [user.workspaceId]);
      await tx.query(
        `UPDATE workspace_sync_cursors SET last_seq = last_seq + 1 WHERE workspace_id = $1`,
        [user.workspaceId],
      );
    });
    const exhausted = await call(t.app, 'GET', changesPath(deviceId, pageOne.json.cursor), {
      token: user.token,
    });
    expect(exhausted.json).toMatchObject({ resources: [], hasMore: false });
    expect(exhausted.json.cursor).toMatch(/:2$/);

    const later = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Sequence three', bodyMd: 'later note' },
      })
    ).json.note as Note;
    const next = await call(t.app, 'GET', changesPath(deviceId, exhausted.json.cursor), {
      token: user.token,
    });
    expect(next.json.resources).toEqual([resource(later)]);
    expect(next.json.cursor).toMatch(/:3$/);
  });

  it('rolls back an earlier generic operation when a later receipt collides', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Atomic adapter', platform: 'web' },
    });
    const bound = mutation(`bound-${randomUUID()}`, randomUUID());
    await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: { deviceId, mutations: [legacyMutation(bound)] },
    });
    const before = (
      (
        await t.client.query(
          `SELECT last_seq FROM workspace_sync_cursors WHERE workspace_id = $1`,
          [user.workspaceId],
        )
      ).rows[0] as { last_seq: bigint }
    ).last_seq;

    const fresh = mutation(`fresh-${randomUUID()}`, randomUUID());
    const collision = mutation(bound.opId, randomUUID(), {
      data: { bodyMd: 'different payload bound to the old id' },
    });
    const rejected = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: [fresh, collision],
      },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.json.error).toMatchObject({
      code: 'idempotency_key_reused',
      operationId: bound.opId,
    });

    const absent = await call(t.app, 'GET', `/v1/notes/${fresh.resource.id}`, {
      token: user.token,
    });
    expect(absent.status).toBe(404);
    const freshReceipt = await t.client.query(
      `SELECT op_id FROM sync_idempotency WHERE workspace_id = $1 AND op_id = $2`,
      [user.workspaceId, fresh.opId],
    );
    expect(freshReceipt.rows).toEqual([]);
    const after = (
      (
        await t.client.query(
          `SELECT last_seq FROM workspace_sync_cursors WHERE workspace_id = $1`,
          [user.workspaceId],
        )
      ).rows[0] as { last_seq: bigint }
    ).last_seq;
    expect(after).toBe(before);
    const history = await call(t.app, 'GET', `/v1/notes/${bound.resource.id}/versions`, {
      token: user.token,
    });
    expect(history.json.versions).toHaveLength(1);
  });
});
