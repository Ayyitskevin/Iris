import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

describe('note versioning (ADR-008)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('keeps a version per save and can restore a prior version', async () => {
    const u = await signUp(t.app);

    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'v1 title', bodyMd: 'first' },
    });
    const id = created.json.note.id;
    expect(created.json.note.version).toBe(1);

    const updated = await call(t.app, 'PATCH', `/v1/notes/${id}`, {
      token: u.token,
      body: { bodyMd: 'second', baseVersion: 1 },
    });
    expect(updated.json.note.version).toBe(2);
    expect(updated.json.note.bodyMd).toBe('second');

    const versions = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    expect(versions.json.versions).toHaveLength(2);
    // Newest first.
    expect(versions.json.versions[0].version).toBe(2);
    const v1 = versions.json.versions.find((v: any) => v.version === 1);

    const restored = await call(t.app, 'POST', `/v1/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: v1.id },
    });
    expect(restored.status).toBe(200);
    expect(restored.json.note.version).toBe(3); // history is append-only
    expect(restored.json.note.bodyMd).toBe('first'); // content of v1 restored
  });

  it('rejects a stale update as a conflict, surfacing the server note', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'race', bodyMd: 'base' },
    });
    const id = created.json.note.id;

    // First writer wins.
    await call(t.app, 'PATCH', `/v1/notes/${id}`, {
      token: u.token,
      body: { bodyMd: 'writer-1', baseVersion: 1 },
    });

    // Second writer used the stale baseVersion 1 → conflict, not silent overwrite.
    const conflict = await call(t.app, 'PATCH', `/v1/notes/${id}`, {
      token: u.token,
      body: { bodyMd: 'writer-2', baseVersion: 1 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe('version_conflict');
    expect(conflict.json.error.conflict.bodyMd).toBe('writer-1');
  });
});
