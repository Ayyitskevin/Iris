import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * Sync v2 (ADR-005/ADR-011): database-monotonic pulls plus request-bound, durable
 * operation receipts. Conflicts are surfaced and every batch remains tenant-atomic.
 */
describe('local-first sync', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('pushes offline mutations, pulls deltas, and surfaces conflicts', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'Laptop', platform: 'web' },
    });

    const noteId = randomUUID();

    // Push a note created offline (baseVersion 0 = brand new).
    const push1 = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          {
            opId: 'op1',
            type: 'upsert',
            note: {
              id: noteId,
              title: 'Offline note',
              bodyMd: 'made offline',
              folder: 'offline/inbox',
              tags: ['Local', 'local'],
            },
            baseVersion: 0,
          },
        ],
      },
    });
    expect(push1.status).toBe(200);
    expect(push1.json.applied).toHaveLength(1);
    expect(push1.json.conflicts).toHaveLength(0);
    expect(push1.json.applied[0].note.version).toBe(1);
    expect(push1.json.applied[0].note).toMatchObject({
      folder: 'offline/inbox',
      tags: ['local'],
    });

    // Pull from genesis returns the note and advances the cursor.
    const pull1 = await call(t.app, 'GET', `/v1/sync/changes?since=&deviceId=${deviceId}`, {
      token: u.token,
    });
    expect(pull1.status).toBe(200);
    expect(pull1.json.changes.some((n: any) => n.id === noteId)).toBe(true);
    const cursor = pull1.json.cursor;
    expect(cursor).toBeTruthy();

    // A well-formed update (correct baseVersion) applies.
    const push2 = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          {
            opId: 'op2',
            type: 'upsert',
            note: {
              id: noteId,
              title: 'Offline note',
              bodyMd: 'edited on device',
              folder: 'offline/archive',
              tags: ['Edited'],
            },
            baseVersion: 1,
          },
        ],
      },
    });
    expect(push2.json.applied[0].note.version).toBe(2);
    expect(push2.json.applied[0].note).toMatchObject({
      folder: 'offline/archive',
      tags: ['edited'],
    });
    const history = await call(t.app, 'GET', `/v1/notes/${noteId}/versions`, {
      token: u.token,
    });
    expect(history.json.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: 1,
          folder: 'offline/inbox',
          folderSnapshotKnown: true,
          tags: ['local'],
        }),
        expect.objectContaining({
          version: 2,
          folder: 'offline/archive',
          folderSnapshotKnown: true,
          tags: ['edited'],
        }),
      ]),
    );

    // A stale update (baseVersion 1 again) conflicts and returns the server state.
    const push3 = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          {
            opId: 'op3',
            type: 'upsert',
            note: { id: noteId, title: 'x', bodyMd: 'stale write', folder: null },
            baseVersion: 1,
          },
        ],
      },
    });
    expect(push3.json.applied).toHaveLength(0);
    expect(push3.json.conflicts).toHaveLength(1);
    expect(push3.json.conflicts[0].reason).toBe('version_mismatch');
    expect(push3.json.conflicts[0].serverNote.bodyMd).toBe('edited on device');

    // Pulling with the earlier cursor surfaces the newer version.
    const pull2 = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=${encodeURIComponent(cursor)}&deviceId=${deviceId}`,
      { token: u.token },
    );
    expect(
      pull2.json.changes.some(
        (note: any) =>
          note.id === noteId &&
          note.version === 2 &&
          note.folder === 'offline/archive' &&
          note.tags.join(',') === 'edited',
      ),
    ).toBe(true);
  });

  it('accepts UUIDs without RFC version bits across REST, push, and V1 cursors', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'UUID compatibility', platform: 'web' },
    });
    const restId = '11111111-1111-1111-1111-111111111111';
    const pushedId = '22222222-2222-2222-2222-222222222222';

    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { id: restId, title: 'PostgreSQL UUID', bodyMd: 'REST' },
    });
    expect(created.status).toBe(201);
    expect(created.json.note.id).toBe(restId);

    const pushed = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          {
            opId: `op-${randomUUID()}`,
            type: 'upsert',
            note: {
              id: pushedId,
              title: 'PostgreSQL UUID',
              bodyMd: 'sync',
              folder: null,
              tags: [],
            },
            baseVersion: 0,
          },
        ],
      },
    });
    expect(pushed.status).toBe(200);
    expect(pushed.json.applied[0].note.id).toBe(pushedId);

    const legacy = `2026-07-15T12:00:00.000Z|${restId}`;
    const replay = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=${encodeURIComponent(legacy)}&deviceId=${deviceId}`,
      { token: u.token },
    );
    expect(replay.status).toBe(200);
    expect(replay.json.cursor).toMatch(new RegExp(`^v2:${u.workspaceId}:[1-9][0-9]*$`));
    expect(new Set(replay.json.changes.map((note: any) => note.id))).toEqual(
      new Set([restId, pushedId]),
    );
  });

  it('accepts the same maximum note metadata through REST and sync', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'Legacy payload compatibility', platform: 'web' },
    });
    const noteId = randomUUID();
    const title = 't'.repeat(500);
    const folder = 'f'.repeat(500);
    const tags = Array.from({ length: 50 }, (_, index) =>
      `tag-${index}-${'x'.repeat(70)}`.slice(0, 80),
    );

    const pushed = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          {
            opId: `op-${randomUUID()}`,
            type: 'upsert',
            note: { id: noteId, title, bodyMd: 'from the shipped editor', folder, tags },
            baseVersion: 0,
          },
        ],
      },
    });

    expect(pushed.status).toBe(200);
    expect(pushed.json.applied[0].note).toMatchObject({ id: noteId, title, folder, tags });
  });

  it('uses database sequences and upgrades only valid legacy cursors', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'Cursor test', platform: 'web' },
    });

    const first = (
      await call(t.app, 'POST', '/v1/notes', {
        token: u.token,
        body: { title: 'First', bodyMd: 'one' },
      })
    ).json.note;
    const second = (
      await call(t.app, 'POST', '/v1/notes', {
        token: u.token,
        body: { title: 'Second', bodyMd: 'two' },
      })
    ).json.note;

    const initial = await call(t.app, 'GET', `/v1/sync/changes?since=&deviceId=${deviceId}`, {
      token: u.token,
    });
    expect(initial.status).toBe(200);
    expect(initial.json.cursor).toMatch(new RegExp(`^v2:${u.workspaceId}:[1-9][0-9]*$`));
    expect(initial.json.changes.map((n: any) => n.id)).toEqual([first.id, second.id]);

    const updated = await call(t.app, 'PATCH', `/v1/notes/${first.id}`, {
      token: u.token,
      body: { bodyMd: 'one updated', baseVersion: 1 },
    });
    expect(updated.status).toBe(200);

    const delta = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=${encodeURIComponent(initial.json.cursor)}&deviceId=${deviceId}`,
      { token: u.token },
    );
    expect(delta.status).toBe(200);
    expect(delta.json.changes.map((n: any) => n.id)).toEqual([first.id]);
    expect(delta.json.cursor).not.toBe(initial.json.cursor);
    expect(delta.json.cursor).toMatch(new RegExp(`^v2:${u.workspaceId}:[1-9][0-9]*$`));

    const legacy = `2026-07-15T12:00:00.000Z|${first.id}`;
    const replay = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=${encodeURIComponent(legacy)}&deviceId=${deviceId}`,
      { token: u.token },
    );
    expect(replay.status).toBe(200);
    expect(replay.json.cursor).toMatch(new RegExp(`^v2:${u.workspaceId}:[1-9][0-9]*$`));
    expect(new Set(replay.json.changes.map((n: any) => n.id))).toEqual(
      new Set([first.id, second.id]),
    );

    for (const invalid of [
      'garbage',
      'v2:-1',
      'v2:01',
      'v2:not-a-workspace:1',
      `v2:${u.workspaceId}:999999999`,
    ]) {
      const rejected = await call(
        t.app,
        'GET',
        `/v1/sync/changes?since=${encodeURIComponent(invalid)}&deviceId=${deviceId}`,
        { token: u.token },
      );
      expect(rejected.status).toBe(400);
      expect(rejected.json.error.code).toBe('invalid_sync_cursor');
    }
  });

  it('binds cursors to one workspace and safely upgrades unbound draft cursors', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const empty = await signUp(t.app);
    const deviceA = `device-${randomUUID()}`;
    const deviceB = `device-${randomUUID()}`;
    const emptyDevice = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: a.token,
      body: { id: deviceA, name: 'Workspace A', platform: 'web' },
    });
    await call(t.app, 'POST', '/v1/devices', {
      token: b.token,
      body: { id: deviceB, name: 'Workspace B', platform: 'web' },
    });
    await call(t.app, 'POST', '/v1/devices', {
      token: empty.token,
      body: { id: emptyDevice, name: 'Empty workspace', platform: 'web' },
    });
    await call(t.app, 'POST', '/v1/notes', {
      token: a.token,
      body: { title: 'A only', bodyMd: 'private A' },
    });
    const noteB = (
      await call(t.app, 'POST', '/v1/notes', {
        token: b.token,
        body: { title: 'B only', bodyMd: 'private B' },
      })
    ).json.note;

    const pullA = await call(t.app, 'GET', `/v1/sync/changes?since=&deviceId=${deviceA}`, {
      token: a.token,
    });
    const swapped = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=${encodeURIComponent(pullA.json.cursor)}&deviceId=${deviceB}`,
      { token: b.token },
    );
    expect(swapped.status).toBe(400);
    expect(swapped.json.error.code).toBe('invalid_sync_cursor');

    const upgraded = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=${encodeURIComponent('v2:999999999')}&deviceId=${deviceB}`,
      { token: b.token },
    );
    expect(upgraded.status).toBe(200);
    expect(upgraded.json.changes.map((note: any) => note.id)).toEqual([noteB.id]);
    expect(upgraded.json.cursor).toMatch(new RegExp(`^v2:${b.workspaceId}:[1-9][0-9]*$`));

    const emptyPull = await call(t.app, 'GET', `/v1/sync/changes?since=&deviceId=${emptyDevice}`, {
      token: empty.token,
    });
    expect(emptyPull.status).toBe(200);
    expect(emptyPull.json).toEqual({
      changes: [],
      cursor: `v2:${empty.workspaceId}:0`,
      hasMore: false,
    });
  });

  it('replays an applied operation exactly and rejects payload or actor reuse', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'Receipt test', platform: 'web' },
    });
    const noteId = randomUUID();
    const mutation = {
      opId: `op-${randomUUID()}`,
      type: 'upsert',
      note: {
        id: noteId,
        title: 'Durable request',
        bodyMd: 'apply exactly once',
        folder: null,
        tags: ['sync'],
      },
      baseVersion: 0,
    };
    const body = { deviceId, mutations: [mutation] };

    const first = await call(t.app, 'POST', '/v1/sync/push', { token: u.token, body });
    const replay = await call(t.app, 'POST', '/v1/sync/push', { token: u.token, body });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    const receipt = (
      await t.client.query(
        `SELECT receipt_version
         FROM sync_idempotency
         WHERE workspace_id = $1 AND op_id = $2`,
        [u.workspaceId, mutation.opId],
      )
    ).rows[0] as { receipt_version: number };
    expect(receipt.receipt_version).toBe(1);

    const current = await call(t.app, 'GET', `/v1/notes/${noteId}`, { token: u.token });
    expect(current.json.note.version).toBe(1);
    const versions = await call(t.app, 'GET', `/v1/notes/${noteId}/versions`, {
      token: u.token,
    });
    expect(versions.json.versions).toHaveLength(1);
    const activity = await call(t.app, 'GET', '/v1/activity', { token: u.token });
    expect(activity.json.activity.filter((a: any) => a.noteId === noteId)).toHaveLength(1);

    const payloadReuse = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          {
            ...mutation,
            note: { ...mutation.note, bodyMd: 'different payload' },
          },
        ],
      },
    });
    expect(payloadReuse.status).toBe(409);
    expect(payloadReuse.json.error.code).toBe('idempotency_key_reused');
    expect(payloadReuse.json.error.operationId).toBe(mutation.opId);

    const issued = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: u.token,
      body: { agentName: 'Sync actor', scopes: ['notes:read', 'notes:write'] },
    });
    const actorReuse = await call(t.app, 'POST', '/v1/sync/push', {
      token: issued.json.token,
      body,
    });
    expect(actorReuse.status).toBe(409);
    expect(actorReuse.json.error.code).toBe('idempotency_key_reused');
    expect(actorReuse.json.error.operationId).toBe(mutation.opId);

    const duplicate = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [mutation, mutation] },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.json.error.code).toBe('validation_error');
  });

  it('replays the original conflict even after the server head moves again', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'Conflict replay', platform: 'web' },
    });
    const original = (
      await call(t.app, 'POST', '/v1/notes', {
        token: u.token,
        body: { title: 'Server head', bodyMd: 'version one' },
      })
    ).json.note;
    const stale = {
      deviceId,
      mutations: [
        {
          opId: `op-${randomUUID()}`,
          type: 'upsert',
          note: {
            id: original.id,
            title: original.title,
            bodyMd: 'stale local edit',
            folder: null,
            tags: [],
          },
          baseVersion: 0,
        },
      ],
    };

    const first = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: stale,
    });
    expect(first.status).toBe(200);
    expect(first.json.conflicts[0].serverNote.version).toBe(1);

    const moved = await call(t.app, 'PATCH', `/v1/notes/${original.id}`, {
      token: u.token,
      body: { bodyMd: 'version two', baseVersion: 1 },
    });
    expect(moved.json.note.version).toBe(2);

    const replay = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: stale,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    expect(replay.json.conflicts[0].serverNote.bodyMd).toBe('version one');
    const receipt = (
      await t.client.query(
        `SELECT receipt_version
         FROM sync_idempotency
         WHERE workspace_id = $1 AND op_id = $2`,
        [u.workspaceId, stale.mutations[0]!.opId],
      )
    ).rows[0] as { receipt_version: number };
    expect(receipt.receipt_version).toBe(1);
  });

  it('fails closed on an unknown durable receipt version before writing a note', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'Future receipt', platform: 'web' },
    });
    const noteId = randomUUID();
    const opId = `op-${randomUUID()}`;
    await t.client.query(
      `INSERT INTO sync_idempotency (
         workspace_id, op_id, actor_type, actor_id, device_id,
         receipt_version, request_fingerprint, outcome
       ) VALUES ($1, $2, 'user', $3, $4, 99, 'future', $5::jsonb)`,
      [u.workspaceId, opId, u.userId, deviceId, JSON.stringify({ kind: 'future' })],
    );

    const rejected = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          {
            opId,
            type: 'upsert',
            note: { id: noteId, title: 'Must not write', bodyMd: 'future', folder: null, tags: [] },
            baseVersion: 0,
          },
        ],
      },
    });
    expect(rejected.status).toBe(500);
    const absent = await call(t.app, 'GET', `/v1/notes/${noteId}`, { token: u.token });
    expect(absent.status).toBe(404);
  });

  it('rolls back an entire batch when a later operation reuses a bound id', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'Atomic batch', platform: 'web' },
    });

    const boundId = randomUUID();
    const boundOpId = `op-${randomUUID()}`;
    const bound = {
      opId: boundOpId,
      type: 'upsert',
      note: {
        id: boundId,
        title: 'Bound',
        bodyMd: 'original payload',
        folder: null,
        tags: [],
      },
      baseVersion: 0,
    };
    const seeded = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [bound] },
    });
    expect(seeded.status).toBe(200);

    const rolledBackId = randomUUID();
    const firstInBatch = {
      opId: `op-${randomUUID()}`,
      type: 'upsert',
      note: {
        id: rolledBackId,
        title: 'Must roll back',
        bodyMd: 'not committed',
        folder: null,
        tags: [],
      },
      baseVersion: 0,
    };
    const failed = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          firstInBatch,
          {
            ...bound,
            note: { ...bound.note, bodyMd: 'colliding payload' },
          },
        ],
      },
    });
    expect(failed.status).toBe(409);
    expect(failed.json.error.code).toBe('idempotency_key_reused');
    expect(failed.json.error.operationId).toBe(boundOpId);

    const absent = await call(t.app, 'GET', `/v1/notes/${rolledBackId}`, {
      token: u.token,
    });
    expect(absent.status).toBe(404);

    const retry = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [firstInBatch] },
    });
    expect(retry.status).toBe(200);
    const committed = await call(t.app, 'GET', `/v1/notes/${rolledBackId}`, {
      token: u.token,
    });
    expect(committed.status).toBe(200);
    expect(committed.json.note.bodyMd).toBe('not committed');
  });

  it('surfaces one conflict when different operation ids race on the same base version', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'CAS race', platform: 'web' },
    });
    const original = (
      await call(t.app, 'POST', '/v1/notes', {
        token: u.token,
        body: { title: 'Race', bodyMd: 'version one' },
      })
    ).json.note;

    const push = (bodyMd: string) =>
      call(t.app, 'POST', '/v1/sync/push', {
        token: u.token,
        body: {
          deviceId,
          mutations: [
            {
              opId: `op-${randomUUID()}`,
              type: 'upsert',
              note: {
                id: original.id,
                title: original.title,
                bodyMd,
                folder: null,
                tags: [],
              },
              baseVersion: 1,
            },
          ],
        },
      });
    const results = await Promise.all([push('writer A'), push('writer B')]);

    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results.flatMap((result) => result.json.applied)).toHaveLength(1);
    expect(results.flatMap((result) => result.json.conflicts)).toHaveLength(1);
    const current = await call(t.app, 'GET', `/v1/notes/${original.id}`, { token: u.token });
    expect(current.json.note.version).toBe(2);
  });

  it('rejects a nonzero base version for a note that does not exist', async () => {
    const u = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: deviceId, name: 'Missing-base test', platform: 'web' },
    });
    const noteId = randomUUID();

    const rejected = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          {
            opId: `op-${randomUUID()}`,
            type: 'upsert',
            note: { id: noteId, title: 'Missing', bodyMd: 'must not create', folder: null },
            baseVersion: 42,
          },
        ],
      },
    });

    expect(rejected.status).toBe(400);
    expect(rejected.json.error.code).toBe('invalid_sync_base_version');
    const absent = await call(t.app, 'GET', `/v1/notes/${noteId}`, { token: u.token });
    expect(absent.status).toBe(404);
  });
});
