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
      body: {
        title: 'v1 title',
        bodyMd: 'first',
        folder: 'projects/original',
        tags: ['alpha'],
      },
    });
    const id = created.json.note.id;
    expect(created.json.note.version).toBe(1);

    const updated = await call(t.app, 'PATCH', `/v1/notes/${id}`, {
      token: u.token,
      body: {
        bodyMd: 'second',
        folder: 'projects/current',
        tags: ['beta'],
        baseVersion: 1,
      },
    });
    expect(updated.json.note.version).toBe(2);
    expect(updated.json.note.bodyMd).toBe('second');

    const versions = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    expect(versions.json.versions).toHaveLength(2);
    expect(versions.json).toMatchObject({ headVersion: 2, restoreProtocolVersion: 1 });
    // Newest first.
    expect(versions.json.versions[0].version).toBe(2);
    const v1 = versions.json.versions.find((v: any) => v.version === 1);
    expect(v1).toMatchObject({
      folder: 'projects/original',
      folderSnapshotKnown: true,
      tags: ['alpha'],
    });

    const restored = await call(t.app, 'POST', `/v1/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: v1.id, baseVersion: 2 },
    });
    expect(restored.status).toBe(200);
    expect(restored.json.folderRestored).toBe(true);
    expect(restored.json.note.version).toBe(3); // history is append-only
    expect(restored.json.note.bodyMd).toBe('first'); // content of v1 restored
    expect(restored.json.note.folder).toBe('projects/original');
    expect(restored.json.note.tags).toEqual(['alpha']);
  });

  it('keeps captured root and empty-string folders distinct', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Folder states', bodyMd: 'root', folder: null },
    });
    const id = created.json.note.id;
    await call(t.app, 'PATCH', `/v1/notes/${id}`, {
      token: u.token,
      body: { bodyMd: 'empty', folder: '', baseVersion: 1 },
    });

    const versions = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    const root = versions.json.versions.find((version: any) => version.version === 1);
    const empty = versions.json.versions.find((version: any) => version.version === 2);
    expect(root).toMatchObject({ folder: null, folderSnapshotKnown: true });
    expect(empty).toMatchObject({ folder: '', folderSnapshotKnown: true });

    const restored = await call(t.app, 'POST', `/v1/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: root.id, baseVersion: 2 },
    });
    expect(restored.json.note.folder).toBeNull();
  });

  it('requires explicit legacy-folder preservation instead of inventing history', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Legacy', bodyMd: 'old body', folder: 'old/folder', tags: ['old'] },
    });
    const id = created.json.note.id;
    await call(t.app, 'PATCH', `/v1/notes/${id}`, {
      token: u.token,
      body: {
        bodyMd: 'current body',
        folder: 'current/folder',
        tags: ['current'],
        baseVersion: 1,
      },
    });
    await t.client.query(
      `UPDATE note_versions
       SET folder = NULL, folder_snapshot_known = false
       WHERE workspace_id = $1 AND note_id = $2 AND version = 1`,
      [u.workspaceId, id],
    );

    const versions = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    const legacy = versions.json.versions.find((version: any) => version.version === 1);
    expect(legacy).toMatchObject({ folder: null, folderSnapshotKnown: false, tags: ['old'] });

    const refused = await call(t.app, 'POST', `/v1/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: legacy.id, baseVersion: 2 },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('incomplete_version_snapshot');

    const accepted = await call(t.app, 'POST', `/v1/notes/${id}/restore`, {
      token: u.token,
      body: {
        versionId: legacy.id,
        baseVersion: 2,
        preserveCurrentFolderIfUnknown: true,
      },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json.folderRestored).toBe(false);
    expect(accepted.json.note).toMatchObject({
      bodyMd: 'old body',
      folder: 'current/folder',
      tags: ['old'],
      version: 3,
    });
  });

  it('rejects a restore chosen from an unseen stale head', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Restore race', bodyMd: 'v1', folder: 'first', tags: ['first'] },
    });
    const id = created.json.note.id;
    const history = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    const v1 = history.json.versions[0];
    await call(t.app, 'PATCH', `/v1/notes/${id}`, {
      token: u.token,
      body: { bodyMd: 'v2', folder: 'newer', tags: ['newer'], baseVersion: 1 },
    });

    const stale = await call(t.app, 'POST', `/v1/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: v1.id, baseVersion: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('version_conflict');
    expect(stale.json.error.conflict).toMatchObject({
      bodyMd: 'v2',
      folder: 'newer',
      tags: ['newer'],
      version: 2,
    });
    const unchanged = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    expect(unchanged.json.versions).toHaveLength(2);
  });

  it('fails closed when an older client omits the restore precondition', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Cutover', bodyMd: 'unchanged' },
    });
    const id = created.json.note.id;
    const history = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });

    const refused = await call(t.app, 'POST', `/v1/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: history.json.versions[0].id },
    });
    expect(refused.status).toBe(428);
    expect(refused.json.error.code).toBe('restore_precondition_required');

    const unchanged = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    expect(unchanged.json).toMatchObject({ headVersion: 1, restoreProtocolVersion: 1 });
    expect(unchanged.json.versions).toHaveLength(1);
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
