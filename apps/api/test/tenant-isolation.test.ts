import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * DoD: "there is a test proving workspace A cannot read workspace B's notes." This is
 * the authoritative in-repo proof of tenant isolation (ADR-003) — enforced at the
 * application layer, so it holds regardless of the DB driver.
 */
describe('tenant isolation', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('workspace A cannot read, update, or delete workspace B notes', async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);

    const created = await call(t.app, 'POST', '/v1/notes', {
      token: alice.token,
      body: { title: 'Alice secret', bodyMd: 'private to alice' },
    });
    expect(created.status).toBe(201);
    const noteId = created.json.note.id;
    expect(created.json.note.workspaceId).toBe(alice.workspaceId);
    const aliceHistory = await call(t.app, 'GET', `/v1/notes/${noteId}/versions`, {
      token: alice.token,
    });
    const aliceVersionId = aliceHistory.json.versions[0].id;
    const aliceActivity = await call(t.app, 'GET', '/v1/activity', { token: alice.token });
    const aliceActivityId = aliceActivity.json.activity.find(
      (entry: any) => entry.noteId === noteId,
    ).id;

    // Bob's list never contains Alice's note.
    const bobList = await call(t.app, 'GET', '/v1/notes', { token: bob.token });
    expect(bobList.json.notes).toHaveLength(0);

    // Bob cannot fetch it by id.
    const bobGet = await call(t.app, 'GET', `/v1/notes/${noteId}`, { token: bob.token });
    expect(bobGet.status).toBe(404);

    // Bob cannot update it.
    const bobUpdate = await call(t.app, 'PATCH', `/v1/notes/${noteId}`, {
      token: bob.token,
      body: { bodyMd: 'hijacked', baseVersion: 1 },
    });
    expect(bobUpdate.status).toBe(404);

    // Bob cannot delete it.
    const bobDelete = await call(t.app, 'DELETE', `/v1/notes/${noteId}`, {
      token: bob.token,
      body: { baseVersion: 1 },
    });
    expect(bobDelete.status).toBe(404);

    // History, restore, and activity undo preserve the same boundary.
    const bobHistory = await call(t.app, 'GET', `/v1/notes/${noteId}/versions`, {
      token: bob.token,
    });
    expect(bobHistory.status).toBe(404);
    const bobRestore = await call(t.app, 'POST', `/v2/notes/${noteId}/restore`, {
      token: bob.token,
      body: { versionId: aliceVersionId, baseVersion: 1 },
    });
    expect(bobRestore.status).toBe(404);
    const bobUndo = await call(t.app, 'POST', `/v2/activity/${aliceActivityId}/undo`, {
      token: bob.token,
    });
    expect(bobUndo.status).toBe(404);

    // Alice still sees exactly her one note, unchanged.
    const aliceList = await call(t.app, 'GET', '/v1/notes', { token: alice.token });
    expect(aliceList.json.notes).toHaveLength(1);
    expect(aliceList.json.notes[0].bodyMd).toBe('private to alice');
  });

  it('an agent token is scoped to its own workspace and cannot cross the boundary', async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);

    // Bob's agent.
    const issued = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: bob.token,
      body: { agentName: 'Bob bot', scopes: ['notes:read', 'notes:write'] },
    });
    const agentToken = issued.json.token;

    // Alice writes a note.
    const aliceNote = await call(t.app, 'POST', '/v1/notes', {
      token: alice.token,
      body: { title: 'Alice only', bodyMd: 'x' },
    });

    // Bob's agent cannot see Alice's note.
    const agentGet = await call(t.app, 'GET', `/v1/notes/${aliceNote.json.note.id}`, {
      token: agentToken,
    });
    expect(agentGet.status).toBe(404);

    const agentList = await call(t.app, 'GET', '/v1/notes', { token: agentToken });
    expect(agentList.json.notes).toHaveLength(0);
  });
});
