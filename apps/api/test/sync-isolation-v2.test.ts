import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

describe('Sync v2 workspace identity and device registration', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeApp();
  });

  afterAll(() => t.close());

  it('allows the default device id in two workspaces', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);

    const registered = await Promise.all(
      [a, b].map((owner) =>
        call(t.app, 'POST', '/v1/devices', {
          token: owner.token,
          body: { id: 'default', name: 'Default device', platform: 'web' },
        }),
      ),
    );
    expect(registered.map((result) => result.status)).toEqual([200, 200]);
    expect(registered.map((result) => result.json.activeDevices)).toEqual([1, 1]);

    const rows = (
      await t.client.query(
        `SELECT workspace_id, id
         FROM devices
         WHERE id = 'default'
         ORDER BY workspace_id`,
      )
    ).rows as Array<{ workspace_id: string; id: string }>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.workspace_id))).toEqual(
      new Set([a.workspaceId, b.workspaceId]),
    );

    // Omitting deviceId exercises the wire contract's legacy default value.
    const pulls = await Promise.all(
      [a, b].map((owner) => call(t.app, 'GET', '/v1/sync/changes?since=', { token: owner.token })),
    );
    expect(pulls.map((result) => result.status)).toEqual([200, 200]);
    expect(pulls.map((result) => result.json.cursor)).toEqual([
      `v2:${a.workspaceId}:0`,
      `v2:${b.workspaceId}:0`,
    ]);
  });

  it('allows one client note UUID and operation id in two workspaces', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const deviceId = `shared-device-${randomUUID()}`;
    for (const owner of [a, b]) {
      const registered = await call(t.app, 'POST', '/v1/devices', {
        token: owner.token,
        body: { id: deviceId, name: 'Shared installation id', platform: 'web' },
      });
      expect(registered.status).toBe(200);
    }

    const noteId = randomUUID();
    const push = (owner: typeof a, bodyMd: string) =>
      call(t.app, 'POST', '/v1/sync/push', {
        token: owner.token,
        body: {
          deviceId,
          mutations: [
            {
              opId: 'shared-create',
              type: 'upsert',
              note: { id: noteId, title: 'Shared UUID', bodyMd, folder: null, tags: [] },
              baseVersion: 0,
            },
          ],
        },
      });
    const [pushedA, pushedB] = await Promise.all([
      push(a, 'private workspace A'),
      push(b, 'private workspace B'),
    ]);
    expect([pushedA.status, pushedB.status]).toEqual([200, 200]);
    expect(pushedA.json.applied[0].note.bodyMd).toBe('private workspace A');
    expect(pushedB.json.applied[0].note.bodyMd).toBe('private workspace B');

    const noteRows = (
      await t.client.query(
        `SELECT workspace_id, body_md
         FROM notes
         WHERE id = $1
         ORDER BY workspace_id`,
        [noteId],
      )
    ).rows as Array<{ workspace_id: string; body_md: string }>;
    const versionRows = (
      await t.client.query(
        `SELECT workspace_id, note_id, version
         FROM note_versions
         WHERE note_id = $1
         ORDER BY workspace_id`,
        [noteId],
      )
    ).rows as Array<{ workspace_id: string; note_id: string; version: number }>;
    expect(noteRows).toHaveLength(2);
    expect(versionRows).toHaveLength(2);
    expect(new Set(noteRows.map((row) => row.workspace_id))).toEqual(
      new Set([a.workspaceId, b.workspaceId]),
    );

    const [readA, readB] = await Promise.all([
      call(t.app, 'GET', `/v1/notes/${noteId}`, { token: a.token }),
      call(t.app, 'GET', `/v1/notes/${noteId}`, { token: b.token }),
    ]);
    expect(readA.json.note.bodyMd).toBe('private workspace A');
    expect(readB.json.note.bodyMd).toBe('private workspace B');
  });

  it('does not let a read-only agent auto-register or consume a device slot', async () => {
    const owner = await signUp(t.app);
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: owner.token,
        body: { title: 'Owner registered', bodyMd: 'visible after registration' },
      })
    ).json.note;
    const issued = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: owner.token,
      body: { agentName: 'Read-only sync agent', scopes: ['notes:read'] },
    });
    const deviceId = `reader-${randomUUID()}`;

    const rejected = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=&deviceId=${encodeURIComponent(deviceId)}`,
      { token: issued.json.token },
    );
    expect(rejected.status).toBe(403);
    expect(rejected.json.error.code).toBe('forbidden');
    const before = await call(t.app, 'GET', '/v1/billing/status', { token: owner.token });
    expect(before.json.activeDevices).toBe(0);

    const registered = await call(t.app, 'POST', '/v1/devices', {
      token: owner.token,
      body: { id: deviceId, name: 'Owner-approved reader', platform: 'agent' },
    });
    expect(registered.status).toBe(200);
    expect(registered.json.activeDevices).toBe(1);

    const pulled = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=&deviceId=${encodeURIComponent(deviceId)}`,
      { token: issued.json.token },
    );
    expect(pulled.status).toBe(200);
    expect(pulled.json.changes.map((change: { id: string }) => change.id)).toContain(note.id);
  });

  it('serializes free-plan registrations so concurrent requests consume one slot', async () => {
    const owner = await signUp(t.app);
    const register = (id: string) =>
      call(t.app, 'POST', '/v1/devices', {
        token: owner.token,
        body: { id, name: id, platform: 'web' },
      });

    const results = await Promise.all([register('racing-a'), register('racing-b')]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 402]);
    const status = await call(t.app, 'GET', '/v1/billing/status', { token: owner.token });
    expect(status.json.activeDevices).toBe(1);
  });
});
