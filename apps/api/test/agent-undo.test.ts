import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * DoD: "An agent token can be issued, used to write a note via the API, and that write
 * shows up in the activity feed where the operator can undo it — with a version
 * restored." This is the moat (pillar #2) end to end.
 */
describe('agent actors, activity feed, and undo', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('agent writes are attributable, land in the feed, and are reversible', async () => {
    const user = await signUp(t.app);

    // Operator writes the note.
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: {
          title: 'Roadmap',
          bodyMd: 'original by operator',
          folder: 'operator/folder',
          tags: ['operator'],
        },
      })
    ).json.note;

    // Operator issues a scoped agent token.
    const issued = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: user.token,
      body: { agentName: 'Researcher', scopes: ['notes:read', 'notes:write'] },
    });
    expect(issued.status).toBe(201);
    const agentToken: string = issued.json.token;
    expect(agentToken.startsWith('iris_at_')).toBe(true);

    // The AGENT edits the note through the same API the app uses.
    const agentEdit = await call(t.app, 'PATCH', `/v1/notes/${note.id}`, {
      token: agentToken,
      body: {
        bodyMd: 'rewritten by the agent',
        folder: 'agent/folder',
        tags: ['agent'],
        baseVersion: 1,
      },
    });
    expect(agentEdit.status).toBe(200);
    expect(agentEdit.json.note.version).toBe(2);

    // The write is attributable in the feed: actor is the agent.
    const feed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const agentAction = feed.json.activity.find(
      (a: any) => a.actorType === 'agent' && a.action === 'note.update',
    );
    expect(agentAction).toBeTruthy();
    expect(agentAction.actorName).toBe('Researcher');
    expect(agentAction.undone).toBe(false);

    // The retired path is inert, even though the activity id is otherwise valid.
    const retired = await call(t.app, 'POST', `/v1/activity/${agentAction.id}/undo`, {
      token: user.token,
    });
    expect(retired.status).toBe(428);
    expect(retired.json.error.code).toBe('undo_protocol_upgrade_required');

    // Operator undoes the agent's action → the prior version is restored.
    const undo = await call(t.app, 'POST', `/v2/activity/${agentAction.id}/undo`, {
      token: user.token,
    });
    expect(undo.status).toBe(200);
    expect(undo.json.note.bodyMd).toBe('original by operator'); // version restored
    expect(undo.json.note.folder).toBe('operator/folder');
    expect(undo.json.note.tags).toEqual(['operator']);
    expect(undo.json.folderRestored).toBe(true);
    expect(undo.json.deletionStateRestored).toBe(true);
    expect(undo.json.note.version).toBe(3); // append-only: a new head version

    // The note really is back to the operator's text.
    const after = await call(t.app, 'GET', `/v1/notes/${note.id}`, { token: user.token });
    expect(after.json.note).toMatchObject({
      bodyMd: 'original by operator',
      folder: 'operator/folder',
      tags: ['operator'],
    });
    const versions = await call(t.app, 'GET', `/v1/notes/${note.id}/versions`, {
      token: user.token,
    });
    expect(versions.json.versions[0]).toMatchObject({
      version: 3,
      folder: 'operator/folder',
      folderSnapshotKnown: true,
      isDeleted: false,
      tags: ['operator'],
    });

    // The feed now marks the agent action undone and records a compensating undo entry.
    const feed2 = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const sameAction = feed2.json.activity.find((a: any) => a.id === agentAction.id);
    expect(sameAction.undone).toBe(true);
    expect(feed2.json.activity.some((a: any) => a.action === 'note.undo')).toBe(true);

    // Undoing twice is refused.
    const undoAgain = await call(t.app, 'POST', `/v2/activity/${agentAction.id}/undo`, {
      token: user.token,
    });
    expect(undoAgain.status).toBe(400);
    expect(undoAgain.json.error.code).toBe('already_undone');
  });

  it('undoing an agent create removes the note', async () => {
    const user = await signUp(t.app);
    const issued = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: user.token,
      body: { agentName: 'Filer', scopes: ['notes:write'] },
    });
    const agentToken = issued.json.token;

    const created = await call(t.app, 'POST', '/v1/notes', {
      token: agentToken,
      body: { title: 'Agent note', bodyMd: 'made by agent' },
    });
    expect(created.status).toBe(201);

    const feed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const createAction = feed.json.activity.find(
      (a: any) => a.actorType === 'agent' && a.action === 'note.create',
    );

    const undo = await call(t.app, 'POST', `/v2/activity/${createAction.id}/undo`, {
      token: user.token,
    });
    expect(undo.status).toBe(200);
    expect(undo.json.note.deletedAt).toEqual(expect.any(String)); // create undone => tombstone
    expect(undo.json.deletionStateRestored).toBe(true);

    const list = await call(t.app, 'GET', '/v1/notes', { token: user.token });
    expect(list.json.notes.find((n: any) => n.id === created.json.note.id)).toBeUndefined();
  });

  it('preserves an unknown legacy folder visibly while restoring captured tags', async () => {
    const user = await signUp(t.app);
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: {
          title: 'Legacy',
          bodyMd: 'before',
          folder: 'before/folder',
          tags: ['before'],
        },
      })
    ).json.note;
    await t.client.query(
      `UPDATE note_versions
       SET folder = NULL, folder_snapshot_known = false
       WHERE workspace_id = $1 AND note_id = $2 AND version = 1`,
      [user.workspaceId, note.id],
    );
    const changed = await call(t.app, 'PATCH', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { bodyMd: 'after', folder: 'after/folder', tags: ['after'], baseVersion: 1 },
    });
    const feed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const update = feed.json.activity.find(
      (entry: any) => entry.action === 'note.update' && entry.resultingVersion === 2,
    );

    const undo = await call(t.app, 'POST', `/v2/activity/${update.id}/undo`, {
      token: user.token,
    });
    expect(changed.json.note.folder).toBe('after/folder');
    expect(undo.status).toBe(200);
    expect(undo.json.folderRestored).toBe(false);
    expect(undo.json.note).toMatchObject({
      bodyMd: 'before',
      folder: 'after/folder',
      tags: ['before'],
    });
  });

  it('fails closed when the snapshot required for undo is missing', async () => {
    const user = await signUp(t.app);
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'History', bodyMd: 'before', folder: 'safe', tags: ['safe'] },
      })
    ).json.note;
    await call(t.app, 'PATCH', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { bodyMd: 'after', folder: 'changed', tags: ['changed'], baseVersion: 1 },
    });
    const feed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const update = feed.json.activity.find(
      (entry: any) => entry.action === 'note.update' && entry.resultingVersion === 2,
    );
    await t.client.query(
      'DELETE FROM note_versions WHERE workspace_id = $1 AND note_id = $2 AND version = 1',
      [user.workspaceId, note.id],
    );

    const undo = await call(t.app, 'POST', `/v2/activity/${update.id}/undo`, {
      token: user.token,
    });
    expect(undo.status).toBe(400);
    expect(undo.json.error.code).toBe('incomplete_history');
    const unchanged = await call(t.app, 'GET', `/v1/notes/${note.id}`, { token: user.token });
    expect(unchanged.json.note).toMatchObject({
      bodyMd: 'after',
      folder: 'changed',
      tags: ['changed'],
      version: 2,
    });
    const afterFeed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    expect(afterFeed.json.activity.find((entry: any) => entry.id === update.id).undone).toBe(false);
  });

  it('fails closed when prior deletion state was never captured', async () => {
    const user = await signUp(t.app);
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Legacy lifecycle', bodyMd: 'before', folder: 'known' },
      })
    ).json.note;
    await t.client.query(
      `UPDATE note_versions SET is_deleted = NULL
       WHERE workspace_id = $1 AND note_id = $2 AND version = 1`,
      [user.workspaceId, note.id],
    );
    await call(t.app, 'PATCH', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { bodyMd: 'after', baseVersion: 1 },
    });
    const feed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const update = feed.json.activity.find(
      (entry: any) => entry.action === 'note.update' && entry.resultingVersion === 2,
    );

    const refused = await call(t.app, 'POST', `/v2/activity/${update.id}/undo`, {
      token: user.token,
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('incomplete_history');
    const unchanged = await call(t.app, 'GET', `/v1/notes/${note.id}`, {
      token: user.token,
    });
    expect(unchanged.json.note).toMatchObject({ bodyMd: 'after', version: 2, deletedAt: null });
    const afterFeed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    expect(afterFeed.json.activity.find((entry: any) => entry.id === update.id).undone).toBe(false);
    const history = await call(t.app, 'GET', `/v1/notes/${note.id}/versions`, {
      token: user.token,
    });
    expect(history.json.versions.map((version: any) => version.version)).toEqual([2, 1]);
  });

  it('undoes a restore revival back to a tombstone', async () => {
    const user = await signUp(t.app);
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Restore lifecycle', bodyMd: 'before deletion' },
      })
    ).json.note;
    await call(t.app, 'DELETE', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { baseVersion: 1 },
    });
    const history = await call(t.app, 'GET', `/v1/notes/${note.id}/versions`, {
      token: user.token,
    });
    const liveV1 = history.json.versions.find((version: any) => version.version === 1);
    await call(t.app, 'POST', `/v2/notes/${note.id}/restore`, {
      token: user.token,
      body: { versionId: liveV1.id, baseVersion: 2 },
    });
    const feed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const revival = feed.json.activity.find(
      (entry: any) => entry.action === 'note.restore' && entry.resultingVersion === 3,
    );

    const undo = await call(t.app, 'POST', `/v2/activity/${revival.id}/undo`, {
      token: user.token,
    });
    expect(undo.status).toBe(200);
    expect(undo.json.deletionStateRestored).toBe(true);
    expect(undo.json.note).toMatchObject({ version: 4 });
    expect(undo.json.note.deletedAt).toEqual(expect.any(String));
    const ordinaryRead = await call(t.app, 'GET', `/v1/notes/${note.id}`, {
      token: user.token,
    });
    expect(ordinaryRead.status).toBe(404);
    const finalHistory = await call(t.app, 'GET', `/v1/notes/${note.id}/versions`, {
      token: user.token,
    });
    expect(finalHistory.json.versions[0]).toMatchObject({ version: 4, isDeleted: true });
  });

  it('undoes a delete back to a live note', async () => {
    const user = await signUp(t.app);
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Undo deletion', bodyMd: 'still here' },
      })
    ).json.note;
    await call(t.app, 'DELETE', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { baseVersion: 1 },
    });
    const feed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const deletion = feed.json.activity.find(
      (entry: any) => entry.action === 'note.delete' && entry.resultingVersion === 2,
    );

    const undo = await call(t.app, 'POST', `/v2/activity/${deletion.id}/undo`, {
      token: user.token,
    });
    expect(undo.json).toMatchObject({
      deletionStateRestored: true,
      note: { version: 3, deletedAt: null, bodyMd: 'still here' },
    });
    const ordinaryRead = await call(t.app, 'GET', `/v1/notes/${note.id}`, {
      token: user.token,
    });
    expect(ordinaryRead.status).toBe(200);
  });

  it('undoes a sync revival back to its prior tombstone', async () => {
    const user = await signUp(t.app);
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: deviceId, name: 'Revival test', platform: 'web' },
    });
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Sync lifecycle', bodyMd: 'before deletion', tags: ['before'] },
      })
    ).json.note;
    await call(t.app, 'DELETE', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { baseVersion: 1 },
    });
    const revival = await call(t.app, 'POST', '/v1/sync/push', {
      token: user.token,
      body: {
        deviceId,
        mutations: [
          {
            opId: `revive-${randomUUID()}`,
            type: 'upsert',
            note: {
              id: note.id,
              title: 'Sync lifecycle',
              bodyMd: 'revived draft',
              folder: null,
              tags: ['revived'],
            },
            baseVersion: 2,
          },
        ],
      },
    });
    expect(revival.json.applied[0].note).toMatchObject({
      version: 3,
      deletedAt: null,
      bodyMd: 'revived draft',
    });
    const feed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const revivalAction = feed.json.activity.find(
      (entry: any) => entry.action === 'note.update' && entry.resultingVersion === 3,
    );

    const undo = await call(t.app, 'POST', `/v2/activity/${revivalAction.id}/undo`, {
      token: user.token,
    });
    expect(undo.status).toBe(200);
    expect(undo.json.note).toMatchObject({ version: 4, bodyMd: 'before deletion' });
    expect(undo.json.note.deletedAt).toEqual(expect.any(String));
    const history = await call(t.app, 'GET', `/v1/notes/${note.id}/versions`, {
      token: user.token,
    });
    expect(history.json.versions.slice(0, 3)).toEqual([
      expect.objectContaining({ version: 4, isDeleted: true }),
      expect.objectContaining({ version: 3, isDeleted: false }),
      expect.objectContaining({ version: 2, isDeleted: true }),
    ]);
  });

  it('refuses to apply an old whole-snapshot undo over a newer head', async () => {
    const user = await signUp(t.app);
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Head guard', bodyMd: 'v1', folder: 'v1', tags: ['v1'] },
      })
    ).json.note;
    await call(t.app, 'PATCH', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { bodyMd: 'v2', folder: 'v2', tags: ['v2'], baseVersion: 1 },
    });
    const afterV2 = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    expect(afterV2.json.undoProtocolVersion).toBe(2);
    const target = afterV2.json.activity.find(
      (entry: any) => entry.action === 'note.update' && entry.resultingVersion === 2,
    );
    await call(t.app, 'PATCH', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { bodyMd: 'v3', folder: 'v3', tags: ['v3'], baseVersion: 2 },
    });

    const refused = await call(t.app, 'POST', `/v2/activity/${target.id}/undo`, {
      token: user.token,
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('version_conflict');
    expect(refused.json.error.conflict).toMatchObject({
      bodyMd: 'v3',
      folder: 'v3',
      tags: ['v3'],
      version: 3,
    });

    const unchanged = await call(t.app, 'GET', `/v1/notes/${note.id}`, { token: user.token });
    expect(unchanged.json.note).toMatchObject({
      bodyMd: 'v3',
      folder: 'v3',
      tags: ['v3'],
      version: 3,
    });
    const history = await call(t.app, 'GET', `/v1/notes/${note.id}/versions`, {
      token: user.token,
    });
    expect(history.json.versions).toHaveLength(3);
    const afterFeed = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    expect(afterFeed.json.activity.find((entry: any) => entry.id === target.id).undone).toBe(false);
  });

  it('enforces token scopes and revocation', async () => {
    const user = await signUp(t.app);

    // Read-only agent cannot write.
    const ro = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: user.token,
      body: { agentName: 'Reader', scopes: ['notes:read'] },
    });
    const write = await call(t.app, 'POST', '/v1/notes', {
      token: ro.json.token,
      body: { title: 'nope', bodyMd: 'nope' },
    });
    expect(write.status).toBe(403);

    // A revoked token stops working.
    const rw = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: user.token,
      body: { agentName: 'Temp', scopes: ['notes:read', 'notes:write'] },
    });
    const revoke = await call(t.app, 'DELETE', `/v1/agents/tokens/${rw.json.agentToken.id}`, {
      token: user.token,
    });
    expect(revoke.status).toBe(204);
    const afterRevoke = await call(t.app, 'GET', '/v1/notes', { token: rw.json.token });
    expect(afterRevoke.status).toBe(401);
  });
});
