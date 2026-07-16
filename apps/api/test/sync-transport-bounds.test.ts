import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_NOTE_BODY_BYTES,
  SYNC_HTTP_BODY_LIMIT_BYTES,
  SYNC_PULL_PAGE_LIMIT,
  SYNC_PULL_PAGE_MAX_BYTES,
  SYNC_PUSH_LIMIT,
  SYNC_PUSH_RESPONSE_MAX_BYTES,
  jsonEncodedStringByteLength,
  utf8ByteLength,
} from '@iris/shared';
import { call, makeApp, signUp, type TestApp } from './helpers';

describe('Sync v2 transport envelopes', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('enforces one UTF-8 note bound consistently across REST and sync', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Bounded editor', platform: 'web' },
    });

    const exact = '🙂'.repeat(MAX_NOTE_BODY_BYTES / 4);
    expect(utf8ByteLength(exact)).toBe(MAX_NOTE_BODY_BYTES);
    expect(jsonEncodedStringByteLength(exact)).toBe(MAX_NOTE_BODY_BYTES);
    const accepted = await call(t.app, 'POST', '/v1/notes', {
      token: user.token,
      body: { title: 'Exact UTF-8 boundary', bodyMd: exact },
    });
    expect(accepted.status).toBe(201);

    const rejectedRest = await call(t.app, 'POST', '/v1/notes', {
      token: user.token,
      body: { title: 'Too large', bodyMd: exact + 'a' },
    });
    expect(rejectedRest.status).toBe(400);
    expect(rejectedRest.json.error.code).toBe('validation_error');

    const rejectedSync = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: {
        deviceId,
        mutations: [
          {
            opId: `op-${randomUUID()}`,
            type: 'upsert',
            note: {
              id: randomUUID(),
              title: 'Too large',
              bodyMd: exact + 'a',
              folder: null,
              tags: [],
            },
            baseVersion: 0,
          },
        ],
      },
    });
    expect(rejectedSync.status).toBe(400);
    expect(rejectedSync.json.error.code).toBe('validation_error');

    const escapedExact = '\u0001'.repeat(Math.floor(MAX_NOTE_BODY_BYTES / 6)) + 'x'.repeat(4);
    expect(jsonEncodedStringByteLength(escapedExact)).toBe(MAX_NOTE_BODY_BYTES);
    const escapedAccepted = await call(t.app, 'POST', '/v1/notes', {
      token: user.token,
      body: { title: 'Exact escaped boundary', bodyMd: escapedExact },
    });
    expect(escapedAccepted.status).toBe(201);
    const escapedRejected = await call(t.app, 'POST', '/v1/notes', {
      token: user.token,
      body: { title: 'Escaped boundary exceeded', bodyMd: escapedExact + '\u0001' },
    });
    expect(escapedRejected.status).toBe(400);
    expect(escapedRejected.json.error.code).toBe('validation_error');

    const nulRejected = await call(t.app, 'POST', '/v1/notes', {
      token: user.token,
      body: { title: 'Database text guard', bodyMd: 'before\u0000after' },
    });
    expect(nulRejected.status).toBe(400);
    expect(nulRejected.json.error.code).toBe('validation_error');
  });

  it('preserves Fastify body/parser status codes in the Iris error envelope', async () => {
    const user = await signUp(t.app);
    const oversized = JSON.stringify({
      bodyMd: 'x'.repeat(SYNC_HTTP_BODY_LIMIT_BYTES + 1),
    });
    const tooLarge = await t.app.inject({
      method: 'POST',
      url: '/v1/notes',
      headers: {
        authorization: `Bearer ${user.token}`,
        'content-type': 'application/json',
      },
      payload: oversized,
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe('payload_too_large');

    const malformed = await t.app.inject({
      method: 'POST',
      url: '/v1/notes',
      headers: {
        authorization: `Bearer ${user.token}`,
        'content-type': 'application/json',
      },
      payload: '{"bodyMd":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('invalid_json');
  });

  it('bounds operation work before the workspace transaction loop', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    const mutations = Array.from({ length: SYNC_PUSH_LIMIT + 1 }, (_, index) => ({
      opId: `bounded-${index}`,
      type: 'delete',
      note: {
        id: randomUUID(),
        title: '',
        bodyMd: '',
        folder: null,
        tags: [],
      },
      baseVersion: 0,
    }));
    const response = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: { deviceId, mutations },
    });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('validation_error');
  });

  it('bounds a worst-case modern conflict response', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Response envelope', platform: 'web' },
    });

    // U+0001 is six bytes when JSON-escaped and, unlike NUL, is valid PostgreSQL text.
    const control = '\u0001';
    const bodyMd = control.repeat(Math.floor(MAX_NOTE_BODY_BYTES / 6)) + 'x'.repeat(4);
    const title = control.repeat(500);
    const folder = control.repeat(500);
    const tags = Array.from(
      { length: 50 },
      (_, index) => `${control.repeat(78)}${index.toString().padStart(2, '0')}`,
    );
    const noteIds: string[] = [];
    for (let index = 0; index < SYNC_PUSH_LIMIT; index += 1) {
      const created = await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title, bodyMd, folder, tags },
      });
      expect(created.status).toBe(201);
      noteIds.push(created.json.note.id);
    }

    const response = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: {
        deviceId,
        mutations: noteIds.map((id, index) => ({
          opId: `${control.repeat(190)}-${index}`,
          type: 'upsert',
          note: { id, title: '', bodyMd: '', folder: null, tags: [] },
          baseVersion: 0,
        })),
      },
    });
    expect(response.status).toBe(200);
    expect(response.json.conflicts).toHaveLength(SYNC_PUSH_LIMIT);
    const responseBytes = utf8ByteLength(JSON.stringify(response.json));
    expect(responseBytes).toBeGreaterThan(1_700_000);
    expect(responseBytes).toBeLessThanOrEqual(SYNC_PUSH_RESPONSE_MAX_BYTES);
  });

  it('returns one migrated pre-limit oversized conflict losslessly as an explicit exception', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Legacy recovery', platform: 'web' },
    });

    const noteId = randomUUID();
    const legacyBody = '\u0001'.repeat(Math.ceil(SYNC_PUSH_RESPONSE_MAX_BYTES / 6) + 10_000);
    await t.client.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.current_workspace', $1, true)`, [user.workspaceId]);
      await tx.query(
        `INSERT INTO notes (id, workspace_id, title, body_md)
         VALUES ($1, $2, $3, $4)`,
        [noteId, user.workspaceId, 'Migrated pre-limit note', legacyBody],
      );
    });

    const response = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: {
        deviceId,
        mutations: [
          {
            opId: `legacy-conflict-${randomUUID()}`,
            type: 'upsert',
            note: { id: noteId, title: '', bodyMd: '', folder: null, tags: [] },
            baseVersion: 0,
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    expect(response.json.conflicts).toHaveLength(1);
    expect(response.json.conflicts[0].serverNote.bodyMd).toBe(legacyBody);
    expect(utf8ByteLength(JSON.stringify(response.json))).toBeGreaterThan(
      SYNC_PUSH_RESPONSE_MAX_BYTES,
    );
  });

  it('drains row- and byte-bounded pull pages without omitting a note', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Pagination proof', platform: 'web' },
    });

    const expected = new Set<string>();
    for (let index = 0; index < SYNC_PULL_PAGE_LIMIT + 5; index += 1) {
      const created = await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: `tiny-${index}`, bodyMd: 'tiny' },
      });
      expect(created.status).toBe(201);
      expected.add(created.json.note.id);
    }
    for (let index = 0; index < 12; index += 1) {
      const created = await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: `large-${index}`, bodyMd: String(index).repeat(120_000) },
      });
      expect(created.status).toBe(201);
      expected.add(created.json.note.id);
    }

    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor = '';
    let pages = 0;
    for (;;) {
      const response = await call(
        t.app,
        'GET',
        `/v1/sync/changes?since=${encodeURIComponent(cursor)}&deviceId=${deviceId}`,
        { token: user.token },
      );
      expect(response.status).toBe(200);
      expect(response.json.changes.length).toBeLessThanOrEqual(SYNC_PULL_PAGE_LIMIT);
      expect(utf8ByteLength(JSON.stringify(response.json))).toBeLessThanOrEqual(
        SYNC_PULL_PAGE_MAX_BYTES,
      );
      expect(cursors.has(response.json.cursor)).toBe(false);
      cursors.add(response.json.cursor);
      for (const note of response.json.changes) seen.add(note.id);
      pages += 1;
      if (!response.json.hasMore) break;
      cursor = response.json.cursor;
      expect(pages).toBeLessThan(20);
    }

    expect(pages).toBeGreaterThan(2);
    expect(seen).toEqual(expected);
  });
});
