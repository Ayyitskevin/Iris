import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * Sync change-feed (ADR-005): local mutations push with the base_version they were
 * derived from; a mismatch is surfaced as a conflict, never silently overwritten.
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
            note: { id: noteId, title: 'Offline note', bodyMd: 'made offline', folder: null },
            baseVersion: 0,
          },
        ],
      },
    });
    expect(push1.status).toBe(200);
    expect(push1.json.applied).toHaveLength(1);
    expect(push1.json.conflicts).toHaveLength(0);
    expect(push1.json.applied[0].note.version).toBe(1);

    // Pull from genesis returns the note and advances the cursor.
    const pull1 = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=&deviceId=${deviceId}`,
      { token: u.token },
    );
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
            note: { id: noteId, title: 'Offline note', bodyMd: 'edited on device', folder: null },
            baseVersion: 1,
          },
        ],
      },
    });
    expect(push2.json.applied[0].note.version).toBe(2);

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
    expect(pull2.json.changes.some((n: any) => n.id === noteId && n.version === 2)).toBe(true);
  });
});
