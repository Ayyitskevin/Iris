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
        body: { title: 'Roadmap', bodyMd: 'original by operator' },
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
      body: { bodyMd: 'rewritten by the agent', baseVersion: 1 },
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

    // Operator undoes the agent's action → the prior version is restored.
    const undo = await call(t.app, 'POST', `/v1/activity/${agentAction.id}/undo`, {
      token: user.token,
    });
    expect(undo.status).toBe(200);
    expect(undo.json.note.bodyMd).toBe('original by operator'); // version restored
    expect(undo.json.note.version).toBe(3); // append-only: a new head version

    // The note really is back to the operator's text.
    const after = await call(t.app, 'GET', `/v1/notes/${note.id}`, { token: user.token });
    expect(after.json.note.bodyMd).toBe('original by operator');

    // The feed now marks the agent action undone and records a compensating undo entry.
    const feed2 = await call(t.app, 'GET', '/v1/activity', { token: user.token });
    const sameAction = feed2.json.activity.find((a: any) => a.id === agentAction.id);
    expect(sameAction.undone).toBe(true);
    expect(feed2.json.activity.some((a: any) => a.action === 'note.undo')).toBe(true);

    // Undoing twice is refused.
    const undoAgain = await call(t.app, 'POST', `/v1/activity/${agentAction.id}/undo`, {
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

    const undo = await call(t.app, 'POST', `/v1/activity/${createAction.id}/undo`, {
      token: user.token,
    });
    expect(undo.status).toBe(200);
    expect(undo.json.note).toBeNull(); // create undone => note gone

    const list = await call(t.app, 'GET', '/v1/notes', { token: user.token });
    expect(list.json.notes.find((n: any) => n.id === created.json.note.id)).toBeUndefined();
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
