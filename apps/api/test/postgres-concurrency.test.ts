import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import type { Principal } from '../src/auth/provider';
import type { Database } from '../src/db/client';
import { applyMigrationsPostgres } from '../src/db/migrate';
import { schema } from '../src/db/schema';
import { runTenant } from '../src/tenant';
import { ensureDevice } from '../src/services/devices';

const connectionString = process.env.IRIS_TEST_POSTGRES_URL;
const postgresDescribe = connectionString ? describe : describe.skip;

postgresDescribe('real PostgreSQL concurrency invariants', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (url.pathname !== '/iris_test') {
      throw new Error('IRIS_TEST_POSTGRES_URL must name the dedicated iris_test database');
    }
    await applyMigrationsPostgres(connectionString!);
    pool = new Pool({ connectionString });
    db = drizzleNode(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function rollbackQuietly(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The test's primary assertion/error is more useful than cleanup noise.
    }
  }

  it('blocks a later note transaction until the earlier sequence owner commits', async () => {
    const workspaceId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [
      workspaceId,
      'Commit order proof',
    ]);

    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await first.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
      await first.query('INSERT INTO notes (workspace_id, id, title) VALUES ($1, $2, $3)', [
        workspaceId,
        firstId,
        'first transaction',
      ]);

      await second.query('BEGIN');
      await second.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
      let secondSettled = false;
      const secondInsert = second
        .query('INSERT INTO notes (workspace_id, id, title) VALUES ($1, $2, $3)', [
          workspaceId,
          secondId,
          'second transaction',
        ])
        .then(() => {
          secondSettled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondSettled).toBe(false);

      await first.query('COMMIT');
      await secondInsert;

      const betweenCommits = await pool.query<{ id: string; sync_seq: string }>(
        'SELECT id, sync_seq::text AS sync_seq FROM notes WHERE workspace_id = $1 ORDER BY sync_seq',
        [workspaceId],
      );
      expect(betweenCommits.rows).toEqual([{ id: firstId, sync_seq: '1' }]);

      await second.query('COMMIT');
      const committed = await pool.query<{ id: string; sync_seq: string }>(
        'SELECT id, sync_seq::text AS sync_seq FROM notes WHERE workspace_id = $1 ORDER BY sync_seq',
        [workspaceId],
      );
      expect(committed.rows).toEqual([
        { id: firstId, sync_seq: '1' },
        { id: secondId, sync_seq: '2' },
      ]);
    } catch (error) {
      await rollbackQuietly(first);
      await rollbackQuietly(second);
      throw error;
    } finally {
      first.release();
      second.release();
    }
  });

  it('serializes concurrent first-device claims under the free plan', async () => {
    const workspaceId = randomUUID();
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [
      workspaceId,
      'Device gate proof',
    ]);
    await pool.query(
      "INSERT INTO subscriptions (workspace_id, plan, status) VALUES ($1, 'free', 'none')",
      [workspaceId],
    );
    const principal: Principal = {
      type: 'user',
      id: randomUUID(),
      name: 'Gate owner',
      workspaceId,
      scopes: ['notes:read', 'notes:write'],
    };

    const attempts = await Promise.allSettled([
      runTenant(db, principal, (ctx) =>
        ensureDevice(ctx, 'phone-A', { name: 'Phone A', platform: 'ios' }),
      ),
      runTenant(db, principal, (ctx) =>
        ensureDevice(ctx, 'phone-B', { name: 'Phone B', platform: 'android' }),
      ),
    ]);

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({ status: 402, code: 'payment_required' });
    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM devices WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(count.rows[0]?.count).toBe('1');
  });
});
