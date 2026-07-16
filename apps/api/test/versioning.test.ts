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
    expect(versions.json).toMatchObject({ headVersion: 2, restoreProtocolVersion: 2 });
    // Newest first.
    expect(versions.json.versions[0].version).toBe(2);
    const v1 = versions.json.versions.find((v: any) => v.version === 1);
    expect(v1).toMatchObject({
      folder: 'projects/original',
      folderSnapshotKnown: true,
      isDeleted: false,
      tags: ['alpha'],
    });

    const restored = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: v1.id, baseVersion: 2 },
    });
    expect(restored.status).toBe(200);
    expect(restored.json.folderRestored).toBe(true);
    expect(restored.json.deletionStateRestored).toBe(true);
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

    const restored = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: root.id, baseVersion: 2 },
    });
    expect(restored.json.note.folder).toBeNull();
  });

  it('restores known live and deleted snapshots as new exact lifecycle heads', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Lifecycle', bodyMd: 'original', folder: 'archive', tags: ['state'] },
    });
    const id = created.json.note.id;
    const deleted = await call(t.app, 'DELETE', `/v1/notes/${id}`, {
      token: u.token,
      body: { baseVersion: 1 },
    });
    expect(deleted.json.note).toMatchObject({ version: 2 });
    expect(deleted.json.note.deletedAt).toEqual(expect.any(String));

    const deletedHistory = await call(t.app, 'GET', `/v1/notes/${id}/versions`, {
      token: u.token,
    });
    expect(deletedHistory.json).toMatchObject({ headVersion: 2, restoreProtocolVersion: 2 });
    const liveV1 = deletedHistory.json.versions.find((version: any) => version.version === 1);
    const deletedV2 = deletedHistory.json.versions.find((version: any) => version.version === 2);
    expect(liveV1.isDeleted).toBe(false);
    expect(deletedV2.isDeleted).toBe(true);

    const revived = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: liveV1.id, baseVersion: 2 },
    });
    expect(revived.json).toMatchObject({
      deletionStateRestored: true,
      note: { version: 3, deletedAt: null },
    });

    const retombstoned = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: deletedV2.id, baseVersion: 3 },
    });
    expect(retombstoned.json.deletionStateRestored).toBe(true);
    expect(retombstoned.json.note).toMatchObject({ version: 4 });
    expect(retombstoned.json.note.deletedAt).toEqual(expect.any(String));

    const list = await call(t.app, 'GET', '/v1/notes', { token: u.token });
    expect(list.json.notes.some((note: any) => note.id === id)).toBe(false);
    const finalHistory = await call(t.app, 'GET', `/v1/notes/${id}/versions`, {
      token: u.token,
    });
    expect(finalHistory.json.versions[0]).toMatchObject({ version: 4, isDeleted: true });
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
       SET folder = NULL, folder_snapshot_known = false, is_deleted = NULL
       WHERE workspace_id = $1 AND note_id = $2 AND version = 1`,
      [u.workspaceId, id],
    );

    const versions = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    const legacy = versions.json.versions.find((version: any) => version.version === 1);
    expect(legacy).toMatchObject({ folder: null, folderSnapshotKnown: false, tags: ['old'] });

    const refused = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: legacy.id, baseVersion: 2 },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('incomplete_version_snapshot');

    const accepted = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: {
        versionId: legacy.id,
        baseVersion: 2,
        preserveCurrentFolderIfUnknown: true,
        preserveCurrentDeletionStateIfUnknown: true,
      },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json.folderRestored).toBe(false);
    expect(accepted.json.deletionStateRestored).toBe(false);
    expect(accepted.json.note).toMatchObject({
      bodyMd: 'old body',
      folder: 'current/folder',
      tags: ['old'],
      version: 3,
    });
  });

  it('requires legacy deletion-state preservation independently of a known folder', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Legacy state', bodyMd: 'before', folder: 'known/folder' },
    });
    const id = created.json.note.id;
    await call(t.app, 'PATCH', `/v1/notes/${id}`, {
      token: u.token,
      body: { bodyMd: 'after', baseVersion: 1 },
    });
    await t.client.query(
      `UPDATE note_versions
       SET is_deleted = NULL
       WHERE workspace_id = $1 AND note_id = $2 AND version = 1`,
      [u.workspaceId, id],
    );
    const history = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    const legacy = history.json.versions.find((version: any) => version.version === 1);
    expect(legacy).toMatchObject({
      folder: 'known/folder',
      folderSnapshotKnown: true,
      isDeleted: null,
    });

    const refused = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: legacy.id, baseVersion: 2 },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('incomplete_version_snapshot');

    const accepted = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: {
        versionId: legacy.id,
        baseVersion: 2,
        preserveCurrentDeletionStateIfUnknown: true,
      },
    });
    expect(accepted.json).toMatchObject({
      folderRestored: true,
      deletionStateRestored: false,
      note: { bodyMd: 'before', folder: 'known/folder', deletedAt: null, version: 3 },
    });

    await call(t.app, 'DELETE', `/v1/notes/${id}`, {
      token: u.token,
      body: { baseVersion: 3 },
    });
    const preservedTombstone = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: {
        versionId: legacy.id,
        baseVersion: 4,
        preserveCurrentDeletionStateIfUnknown: true,
      },
    });
    expect(preservedTombstone.json.deletionStateRestored).toBe(false);
    expect(preservedTombstone.json.note).toMatchObject({ bodyMd: 'before', version: 5 });
    expect(preservedTombstone.json.note.deletedAt).toEqual(expect.any(String));
    const ordinaryRead = await call(t.app, 'GET', `/v1/notes/${id}`, { token: u.token });
    expect(ordinaryRead.status).toBe(404);
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

    const stale = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
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

  it('fails closed across old paths and missing restore preconditions', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Cutover', bodyMd: 'unchanged' },
    });
    const id = created.json.note.id;
    const history = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });

    const oldPath = await call(t.app, 'POST', `/v1/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: history.json.versions[0].id, baseVersion: 1 },
    });
    expect(oldPath.status).toBe(428);
    expect(oldPath.json.error.code).toBe('restore_protocol_upgrade_required');

    const refused = await call(t.app, 'POST', `/v2/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: history.json.versions[0].id },
    });
    expect(refused.status).toBe(428);
    expect(refused.json.error.code).toBe('restore_precondition_required');

    const unchanged = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    expect(unchanged.json).toMatchObject({ headVersion: 1, restoreProtocolVersion: 2 });
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
