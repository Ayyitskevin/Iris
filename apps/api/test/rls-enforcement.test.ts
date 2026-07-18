import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * Runtime proof of Row-Level Security (ADR-003), the defense-in-depth backstop under the
 * application-layer tenant filter. The existing tenant-isolation test exercises the app layer
 * only; PGlite connects as a superuser, which BYPASSES RLS, so the policies themselves are
 * never actually exercised in CI (see the note in migration 0001). This test `SET ROLE`s to a
 * non-superuser role that IS subject to RLS and proves the `workspace_isolation` policy denies
 * cross-tenant reads and writes — and that every tenant table still has forced RLS + the
 * policy, so a future migration that drops either on any table fails here instead of silently
 * leaking one workspace's data to another in production.
 */
const TENANT_TABLES = [
  'workspace_members',
  'notes',
  'note_versions',
  'activity_log',
  'devices',
  'subscriptions',
  'workspace_sync_cursors',
  'sync_idempotency',
];

describe('RLS runtime enforcement (non-superuser role subject to RLS)', () => {
  let t: TestApp;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    t = await makeApp();
    alice = await signUp(t.app);
    bob = await signUp(t.app);
    // Populate tenant tables in both workspaces through the real app (notes → notes +
    // note_versions + activity_log + workspace_sync_cursors; sign-up → workspace_members).
    await call(t.app, 'POST', '/v1/notes', {
      token: alice.token,
      body: { title: 'Alice secret', bodyMd: 'private to alice' },
    });
    await call(t.app, 'POST', '/v1/notes', {
      token: bob.token,
      body: { title: 'Bob secret', bodyMd: 'private to bob' },
    });

    // A role that does NOT bypass RLS, with the same DML grants the app role has in prod.
    await t.client.exec(`
      CREATE ROLE iris_rls_tester NOLOGIN;
      GRANT USAGE ON SCHEMA public TO iris_rls_tester;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO iris_rls_tester;
    `);
  });

  afterAll(async () => {
    await t.client.exec('RESET ROLE').catch(() => undefined);
    await t.close();
  });

  /**
   * Run `fn` as the RLS-subject role with `app.current_workspace = workspaceId`, exactly as
   * production does it (`withWorkspace`): inside a transaction with `SET LOCAL ROLE` and a
   * transaction-local `set_config`. `ROLLBACK` reverts both — so the session GUC is never
   * polluted (leaving the true fail-closed NULL path intact) and it also cleanly ends a
   * transaction aborted by a policy violation. A missing `workspaceId` sets nothing, so
   * `current_setting(..., true)` stays NULL (the real un-scoped path).
   */
  async function underRole<T>(workspaceId: string | null, fn: () => Promise<T>): Promise<T> {
    await t.client.exec('BEGIN');
    try {
      if (workspaceId !== null) {
        await t.client.query(`SELECT set_config('app.current_workspace', $1, true)`, [workspaceId]);
      }
      await t.client.exec('SET LOCAL ROLE iris_rls_tester');
      return await fn();
    } finally {
      await t.client.exec('ROLLBACK');
    }
  }

  async function count(table: string, workspaceId?: string): Promise<number> {
    const sql = workspaceId
      ? `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`
      : `SELECT count(*)::int AS n FROM ${table}`;
    const res = await t.client.query(sql, workspaceId ? [workspaceId] : []);
    return (res.rows[0] as { n: number }).n;
  }

  it('the test role does not bypass RLS', async () => {
    const res = await t.client.query(
      `SELECT rolbypassrls AS bypass, rolsuper AS super FROM pg_roles WHERE rolname = 'iris_rls_tester'`,
    );
    expect(res.rows[0]).toMatchObject({ bypass: false, super: false });
  });

  it('sees only its own workspace rows across every populated tenant table', async () => {
    await underRole(alice.workspaceId, async () => {
      // Alice's own note is visible; Bob's is invisible even when queried by his id.
      expect(await count('notes')).toBe(1);
      expect(await count('notes', bob.workspaceId)).toBe(0);

      // Not notes-specific: the same isolation holds on other populated tenant tables.
      for (const table of ['note_versions', 'activity_log', 'workspace_members']) {
        expect(await count(table, alice.workspaceId)).toBeGreaterThan(0);
        expect(await count(table, bob.workspaceId)).toBe(0);
      }
    });
  });

  it('fails closed: an un-scoped query cannot read tenant data', async () => {
    await underRole(null, async () => {
      // No workspace GUC is set. The policy is fail-closed either way: on a virgin session
      // `current_setting(..., true)` is NULL and every row is excluded (0 rows); once the GUC
      // has been touched in the session (as every real request does) an unset read is '' and
      // the `''::uuid` cast rejects the query. Both mean no cross-tenant data is returned.
      let leaked: number;
      try {
        leaked = await count('notes');
      } catch {
        leaked = 0; // rejected == nothing returned == fail closed
      }
      expect(leaked).toBe(0);
    });
  });

  it('cannot write into another workspace (policy WITH CHECK denies cross-tenant insert)', async () => {
    // A cross-tenant INSERT is rejected by the policy's WITH CHECK clause.
    await underRole(alice.workspaceId, async () => {
      await expect(
        t.client.query(`INSERT INTO subscriptions (workspace_id) VALUES ($1)`, [bob.workspaceId]),
      ).rejects.toThrow(/row-level security|policy/i);
    });

    // And a cross-tenant UPDATE touches nothing — Bob's rows are invisible to the USING clause,
    // so `RETURNING` yields zero rows.
    await underRole(alice.workspaceId, async () => {
      const res = await t.client.query(
        `UPDATE notes SET title = 'hijacked' WHERE workspace_id = $1 RETURNING id`,
        [bob.workspaceId],
      );
      expect(res.rows).toHaveLength(0);
    });
  });

  it('every tenant table has forced RLS and the workspace_isolation policy', async () => {
    const res = await t.client.query(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS enabled,
              c.relforcerowsecurity AS forced,
              EXISTS (
                SELECT 1 FROM pg_policies p
                WHERE p.tablename = c.relname AND p.policyname = 'workspace_isolation'
              ) AS has_policy
       FROM pg_class c
       WHERE c.relkind = 'r' AND c.relname = ANY($1)
       ORDER BY c.relname`,
      [TENANT_TABLES],
    );
    const rows = res.rows as Array<{
      table_name: string;
      enabled: boolean;
      forced: boolean;
      has_policy: boolean;
    }>;
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TENANT_TABLES].sort());
    for (const r of rows) {
      expect(r.enabled, `${r.table_name}: RLS enabled`).toBe(true);
      expect(r.forced, `${r.table_name}: RLS forced`).toBe(true);
      expect(r.has_policy, `${r.table_name}: workspace_isolation policy present`).toBe(true);
    }
  });
});
