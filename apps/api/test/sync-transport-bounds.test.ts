import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_NOTE_BODY_BYTES,
  SYNC_HTTP_BODY_LIMIT_BYTES,
  SYNC_PULL_PAGE_LIMIT,
  SYNC_PULL_PAGE_MAX_BYTES,
  SYNC_PUSH_LIMIT,
  SYNC_PUSH_RESPONSE_MAX_BYTES,
  SYNC_V2_RESOURCE_SET,
  jsonEncodedStringByteLength,
  utf8ByteLength,
  type Note,
} from '@iris/shared';
import { call, makeApp, signUp, type TestApp } from './helpers';

function noteResource(note: Note) {
  const { id, ...data } = note;
  return { type: 'note' as const, id, data };
}

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

    const rejectedV2 = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: [
          {
            opId: `v2-${randomUUID()}`,
            type: 'upsert',
            resource: {
              type: 'note',
              id: randomUUID(),
              data: { title: 'Too large', bodyMd: exact + 'a', folder: null, tags: [] },
            },
            baseVersion: 0,
          },
        ],
      },
    });
    expect(rejectedV2.status).toBe(400);
    expect(rejectedV2.json.error.code).toBe('validation_error');

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

    const generic = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: mutations.map(({ note, ...item }) => ({
          ...item,
          resource: {
            type: 'note',
            id: note.id,
            data: {
              title: note.title,
              bodyMd: note.bodyMd,
              folder: note.folder,
              tags: note.tags,
            },
          },
        })),
      },
    });
    expect(generic.status).toBe(400);
    expect(generic.json.error.code).toBe('validation_error');
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

    const mutations = noteIds.map((id, index) => ({
      opId: `${control.repeat(190)}-${index}`,
      type: 'upsert',
      note: { id, title: '', bodyMd: '', folder: null, tags: [] },
      baseVersion: 0,
    }));
    const response = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: { deviceId, mutations },
    });
    expect(response.status).toBe(200);
    expect(response.json.conflicts).toHaveLength(SYNC_PUSH_LIMIT);
    const responseBytes = utf8ByteLength(JSON.stringify(response.json));
    expect(responseBytes).toBeGreaterThan(1_700_000);
    expect(responseBytes).toBeLessThanOrEqual(SYNC_PUSH_RESPONSE_MAX_BYTES);

    const generic = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: mutations.map(({ note, ...item }) => ({
          ...item,
          resource: {
            type: 'note',
            id: note.id,
            data: {
              title: note.title,
              bodyMd: note.bodyMd,
              folder: note.folder,
              tags: note.tags,
            },
          },
        })),
      },
    });
    expect(generic.status).toBe(200);
    expect(generic.json.conflicts).toHaveLength(SYNC_PUSH_LIMIT);
    expect(utf8ByteLength(JSON.stringify(generic.json))).toBeLessThanOrEqual(
      SYNC_PUSH_RESPONSE_MAX_BYTES,
    );
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

    const mutation = {
      opId: `legacy-conflict-${randomUUID()}`,
      type: 'upsert',
      note: { id: noteId, title: '', bodyMd: '', folder: null, tags: [] },
      baseVersion: 0,
    };
    const response = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: { deviceId, mutations: [mutation] },
    });
    expect(response.status).toBe(200);
    expect(response.json.conflicts).toHaveLength(1);
    expect(response.json.conflicts[0].serverNote.bodyMd).toBe(legacyBody);
    expect(utf8ByteLength(JSON.stringify(response.json))).toBeGreaterThan(
      SYNC_PUSH_RESPONSE_MAX_BYTES,
    );

    const generic = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: {
        resourceSet: SYNC_V2_RESOURCE_SET,
        deviceId,
        mutations: [
          {
            opId: mutation.opId,
            type: mutation.type,
            resource: {
              type: 'note',
              id: mutation.note.id,
              data: {
                title: mutation.note.title,
                bodyMd: mutation.note.bodyMd,
                folder: mutation.note.folder,
                tags: mutation.note.tags,
              },
            },
            baseVersion: mutation.baseVersion,
          },
        ],
      },
    });
    expect(generic.status).toBe(200);
    expect(generic.json.conflicts[0].serverResource.data.bodyMd).toBe(legacyBody);
    expect(utf8ByteLength(JSON.stringify(generic.json))).toBeGreaterThan(
      SYNC_PUSH_RESPONSE_MAX_BYTES,
    );

    const pull = await call(
      t.app,
      'GET',
      `/v2/sync/changes?resourceSet=${SYNC_V2_RESOURCE_SET}&cursor=&deviceId=${deviceId}`,
      { token: user.token },
    );
    expect(pull.status).toBe(200);
    expect(pull.json.resources).toHaveLength(1);
    expect(pull.json.resources[0].data.bodyMd).toBe(legacyBody);
    expect(utf8ByteLength(JSON.stringify(pull.json))).toBeGreaterThan(SYNC_PULL_PAGE_MAX_BYTES);
  });

  it('rolls back a multi-resource response that must be split to remain bounded', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Response split', platform: 'web' },
    });
    const ids = [randomUUID(), randomUUID()];
    const legacyBody = '\u0001'.repeat(160_000);
    await t.client.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.current_workspace', $1, true)`, [user.workspaceId]);
      await tx.query(
        `INSERT INTO notes (id, workspace_id, title, body_md)
         VALUES ($1, $3, 'Legacy A', $4), ($2, $3, 'Legacy B', $4)`,
        [ids[0], ids[1], user.workspaceId, legacyBody],
      );
    });
    const mutations = ids.map((id, index) => ({
      opId: `split-${index}-${randomUUID()}`,
      type: 'upsert',
      resource: {
        type: 'note',
        id,
        data: { title: '', bodyMd: '', folder: null, tags: [] },
      },
      baseVersion: 0,
    }));

    const rejected = await call(t.app, 'POST', '/v2/sync/push', {
      token: user.token,
      body: { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error.code).toBe('sync_response_too_large');
    const rolledBack = await t.client.query(
      `SELECT op_id FROM sync_idempotency
       WHERE workspace_id = $1 AND op_id = ANY($2::text[])`,
      [user.workspaceId, mutations.map((item) => item.opId)],
    );
    expect(rolledBack.rows).toEqual([]);

    for (const item of mutations) {
      const split = await call(t.app, 'POST', '/v2/sync/push', {
        token: user.token,
        body: { resourceSet: SYNC_V2_RESOURCE_SET, deviceId, mutations: [item] },
      });
      expect(split.status).toBe(200);
      expect(split.json.conflicts).toHaveLength(1);
      expect(utf8ByteLength(JSON.stringify(split.json))).toBeLessThanOrEqual(
        SYNC_PUSH_RESPONSE_MAX_BYTES,
      );
    }
  });

  it('moves the decisive wrapper-overhead resource onto the next pull page', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Exact pull boundary', platform: 'web' },
    });

    const notes: Note[] = [];
    for (let index = 0; index < 4; index += 1) {
      const bodyBytes = index === 3 ? MAX_NOTE_BODY_BYTES - 8_000 : MAX_NOTE_BODY_BYTES;
      const created = await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: `boundary-${index}`, bodyMd: 'x'.repeat(bodyBytes) },
      });
      expect(created.status).toBe(201);
      notes.push(created.json.note as Note);
    }

    const emptyEnvelopeBytes = (sequence: bigint) =>
      utf8ByteLength(
        JSON.stringify({
          resourceSet: SYNC_V2_RESOURCE_SET,
          resources: [],
          cursor: `resource-v1:${SYNC_V2_RESOURCE_SET}:${user.workspaceId}:${sequence}`,
          hasMore: false,
        }),
      );
    const innerOnlyBytes = (sequence: bigint) =>
      emptyEnvelopeBytes(sequence) +
      notes.reduce(
        (bytes, note, index) =>
          bytes + utf8ByteLength(JSON.stringify(note)) + (index === 0 ? 0 : 1),
        0,
      );

    // Calibrate the fourth body so serializing bare notes would appear to fit by a few
    // bytes, while the required type/data resource wrappers make the page exceed 1 MiB.
    const targetInnerBytes = SYNC_PULL_PAGE_MAX_BYTES - 16;
    const delta = targetInnerBytes - innerOnlyBytes(4n);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(8_000);
    const last = notes[3]!;
    const updated = await call(t.app, 'PATCH', `/v1/notes/${last.id}`, {
      token: user.token,
      body: { bodyMd: last.bodyMd + 'x'.repeat(delta), baseVersion: last.version },
    });
    expect(updated.status).toBe(200);
    notes[3] = updated.json.note as Note;

    const counter = await t.client.query(
      `SELECT last_seq FROM workspace_sync_cursors WHERE workspace_id = $1`,
      [user.workspaceId],
    );
    const highWater = (counter.rows[0] as { last_seq: bigint }).last_seq;
    const misleadingInnerBytes = innerOnlyBytes(highWater);
    const completeEnvelopeBytes = utf8ByteLength(
      JSON.stringify({
        resourceSet: SYNC_V2_RESOURCE_SET,
        resources: notes.map(noteResource),
        cursor: `resource-v1:${SYNC_V2_RESOURCE_SET}:${user.workspaceId}:${highWater}`,
        hasMore: false,
      }),
    );
    expect(misleadingInnerBytes).toBeGreaterThan(SYNC_PULL_PAGE_MAX_BYTES - 32);
    expect(misleadingInnerBytes).toBeLessThanOrEqual(SYNC_PULL_PAGE_MAX_BYTES);
    expect(completeEnvelopeBytes).toBeGreaterThan(SYNC_PULL_PAGE_MAX_BYTES);

    const first = await call(
      t.app,
      'GET',
      `/v2/sync/changes?resourceSet=${SYNC_V2_RESOURCE_SET}&cursor=&deviceId=${deviceId}`,
      { token: user.token },
    );
    expect(first.status).toBe(200);
    expect(first.json.resources).toHaveLength(3);
    expect(first.json.hasMore).toBe(true);
    expect(utf8ByteLength(JSON.stringify(first.json))).toBeLessThanOrEqual(
      SYNC_PULL_PAGE_MAX_BYTES,
    );

    const second = await call(
      t.app,
      'GET',
      `/v2/sync/changes?resourceSet=${SYNC_V2_RESOURCE_SET}&cursor=${encodeURIComponent(first.json.cursor)}&deviceId=${deviceId}`,
      { token: user.token },
    );
    expect(second.status).toBe(200);
    expect(second.json.resources).toHaveLength(1);
    expect(second.json.hasMore).toBe(false);
    const emittedIds = [...first.json.resources, ...second.json.resources].map(
      (item: any) => item.id,
    );
    expect(new Set(emittedIds).size).toBe(emittedIds.length);
    expect(new Set(emittedIds)).toEqual(new Set(notes.map((note) => note.id)));
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
    let emitted = 0;
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
      for (const note of response.json.changes) {
        expect(seen.has(note.id)).toBe(false);
        seen.add(note.id);
        emitted += 1;
      }
      pages += 1;
      if (!response.json.hasMore) break;
      cursor = response.json.cursor;
      expect(pages).toBeLessThan(20);
    }

    expect(pages).toBeGreaterThan(2);
    expect(seen).toEqual(expected);
    expect(emitted).toBe(expected.size);

    const genericSeen = new Set<string>();
    const genericCursors = new Set<string>();
    const genericCursorPrefix = `resource-v1:${SYNC_V2_RESOURCE_SET}:${user.workspaceId}:`;
    let genericEmitted = 0;
    let previousSequence = -1n;
    let insertedMidDrain = false;
    cursor = '';
    pages = 0;
    for (;;) {
      const response = await call(
        t.app,
        'GET',
        `/v2/sync/changes?resourceSet=${SYNC_V2_RESOURCE_SET}&cursor=${encodeURIComponent(cursor)}&deviceId=${deviceId}`,
        { token: user.token },
      );
      expect(response.status).toBe(200);
      expect(response.json.resourceSet).toBe(SYNC_V2_RESOURCE_SET);
      expect(response.json.resources.length).toBeLessThanOrEqual(SYNC_PULL_PAGE_LIMIT);
      expect(response.json.resources.every((item: any) => item.type === 'note')).toBe(true);
      expect(utf8ByteLength(JSON.stringify(response.json))).toBeLessThanOrEqual(
        SYNC_PULL_PAGE_MAX_BYTES,
      );
      expect(genericCursors.has(response.json.cursor)).toBe(false);
      genericCursors.add(response.json.cursor);
      expect(response.json.cursor.startsWith(genericCursorPrefix)).toBe(true);
      const sequence = BigInt(response.json.cursor.slice(genericCursorPrefix.length));
      expect(sequence > previousSequence).toBe(true);
      previousSequence = sequence;
      for (const item of response.json.resources) {
        expect(genericSeen.has(item.id)).toBe(false);
        genericSeen.add(item.id);
        genericEmitted += 1;
      }
      if (!insertedMidDrain) {
        expect(response.json.hasMore).toBe(true);
        const inserted = await call(t.app, 'POST', '/v1/notes', {
          token: user.token,
          body: { title: 'written-between-pages', bodyMd: 'must drain exactly once' },
        });
        expect(inserted.status).toBe(201);
        expected.add(inserted.json.note.id);
        insertedMidDrain = true;
      }
      pages += 1;
      if (!response.json.hasMore) break;
      cursor = response.json.cursor;
      expect(pages).toBeLessThan(20);
    }

    expect(pages).toBeGreaterThan(2);
    expect(genericSeen).toEqual(expected);
    expect(genericEmitted).toBe(expected.size);
  });
});
