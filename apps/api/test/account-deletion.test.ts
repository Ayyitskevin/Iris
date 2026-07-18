import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * Irreversible account deletion (plan A5, audit #7) — the App Store 5.1.1(v) / GDPR Art. 17
 * launch requirement. Deleting the workspace cascades every tenant table; the owning user row
 * is removed too. This proves the erasure is complete and scoped to the caller's own workspace.
 */
const TENANT_TABLES = [
  'workspace_members',
  'notes',
  'note_versions',
  'activity_log',
  'devices',
  'agent_tokens',
  'subscriptions',
  'workspace_sync_cursors',
  'sync_idempotency',
];

describe('account deletion', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(() => t.close());

  async function count(table: string, workspaceId: string): Promise<number> {
    const res = await t.client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`,
      [workspaceId],
    );
    return (res.rows[0] as { n: number }).n;
  }

  async function rowExists(sql: string, id: string): Promise<boolean> {
    const res = await t.client.query(sql, [id]);
    return (res.rows[0] as { n: number }).n > 0;
  }

  /** Populate every tenant table this account can reach through the app. */
  async function seed(user: Awaited<ReturnType<typeof signUp>>): Promise<void> {
    await call(t.app, 'POST', '/v1/notes', {
      token: user.token,
      body: { title: 'A note', bodyMd: 'body' },
    });
    await call(t.app, 'POST', '/v1/devices', {
      token: user.token,
      body: { id: 'device-1', name: 'Phone', platform: 'ios' },
    });
    await call(t.app, 'POST', '/v1/agents/tokens', {
      token: user.token,
      body: { agentName: 'bot', scopes: ['notes:read'] },
    });
  }

  it('erases the workspace, all tenant data, and the owner, and blocks re-login', async () => {
    const alice = await signUp(t.app);
    await seed(alice);

    // Sanity: data really is there before deletion.
    expect(await count('notes', alice.workspaceId)).toBeGreaterThan(0);
    expect(await count('devices', alice.workspaceId)).toBeGreaterThan(0);
    expect(await count('agent_tokens', alice.workspaceId)).toBeGreaterThan(0);
    expect(await count('subscriptions', alice.workspaceId)).toBeGreaterThan(0);

    const res = await call(t.app, 'DELETE', '/v1/account', {
      token: alice.token,
      body: { confirmEmail: alice.email },
    });
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(true);

    // Every tenant table is empty for the deleted workspace.
    for (const table of TENANT_TABLES) {
      expect(await count(table, alice.workspaceId), `${table} should be empty`).toBe(0);
    }
    // The workspace row and the owning user row are gone.
    expect(
      await rowExists('SELECT count(*)::int AS n FROM workspaces WHERE id = $1', alice.workspaceId),
    ).toBe(false);
    expect(
      await rowExists('SELECT count(*)::int AS n FROM users WHERE id = $1', alice.userId),
    ).toBe(false);

    // The account is truly gone: the credentials can no longer sign in.
    const relogin = await call(t.app, 'POST', '/v1/auth/sign-in', {
      body: { email: alice.email, password: 'correct-horse-battery' },
    });
    expect(relogin.status).toBe(401);
  });

  it('requires the confirmation email to match, and changes nothing otherwise', async () => {
    const alice = await signUp(t.app);
    await seed(alice);

    const res = await call(t.app, 'DELETE', '/v1/account', {
      token: alice.token,
      body: { confirmEmail: 'someone-else@example.com' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('account_deletion_unconfirmed');

    // The account and its data are untouched.
    expect(await count('notes', alice.workspaceId)).toBeGreaterThan(0);
    expect(
      await rowExists('SELECT count(*)::int AS n FROM workspaces WHERE id = $1', alice.workspaceId),
    ).toBe(true);
  });

  it('is operator-only: an agent token cannot delete the account', async () => {
    const alice = await signUp(t.app);
    const issued = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: alice.token,
      body: { agentName: 'bot', scopes: ['notes:read', 'notes:write'] },
    });
    const agentToken = issued.json.token as string;

    const res = await call(t.app, 'DELETE', '/v1/account', {
      token: agentToken,
      body: { confirmEmail: alice.email },
    });
    expect(res.status).toBe(403);
    expect(
      await rowExists('SELECT count(*)::int AS n FROM workspaces WHERE id = $1', alice.workspaceId),
    ).toBe(true);
  });

  it("deleting one account leaves another workspace's data intact", async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);
    await seed(alice);
    await call(t.app, 'POST', '/v1/notes', {
      token: bob.token,
      body: { title: 'Bob note', bodyMd: 'bob body' },
    });

    const res = await call(t.app, 'DELETE', '/v1/account', {
      token: alice.token,
      body: { confirmEmail: alice.email },
    });
    expect(res.status).toBe(200);

    // Bob is fully intact — data readable and login still works.
    const bobNotes = await call(t.app, 'GET', '/v1/notes', { token: bob.token });
    expect(bobNotes.json.notes).toHaveLength(1);
    expect(await count('notes', bob.workspaceId)).toBe(1);
    const bobLogin = await call(t.app, 'POST', '/v1/auth/sign-in', {
      body: { email: bob.email, password: 'correct-horse-battery' },
    });
    expect(bobLogin.status).toBe(200);
  });
});
