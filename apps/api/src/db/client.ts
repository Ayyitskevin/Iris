/**
 * Database handle. One schema, two drivers (ADR-002):
 *   - production: node-postgres against a real cluster (DATABASE_URL set)
 *   - dev/test:   PGlite (Postgres in WASM, in-process), no server required
 * Query code is identical against both.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { env } from '../env';
import { schema } from './schema';

export type Database = PgliteDatabase<typeof schema>;

export interface DbBundle {
  db: Database;
  /** Release any underlying resources (PGlite instance / pg Pool). */
  close: () => Promise<void>;
  kind: 'pglite' | 'node-postgres';
}

/**
 * Build a database bundle. Pass an explicit PGlite instance in tests to get a fresh,
 * isolated in-memory database per test file.
 */
export function createDb(pglite?: PGlite): DbBundle {
  if (env.databaseUrl) {
    const pool = new Pool({ connectionString: env.databaseUrl });
    return {
      db: drizzleNode(pool, { schema }) as unknown as Database,
      close: async () => {
        await pool.end();
      },
      kind: 'node-postgres',
    };
  }

  const client = pglite ?? new PGlite(process.env.NODE_ENV === 'test' ? undefined : env.pglitePath);
  return {
    db: drizzlePglite(client, { schema }),
    close: async () => {
      await client.close();
    },
    kind: 'pglite',
  };
}

/**
 * Run `fn` inside a transaction that sets the tenant GUC used by RLS policies
 * (`app.current_workspace`). This is the production-correct isolation boundary
 * (ADR-003). App-layer `where workspace_id = …` filters are still applied in every
 * query as the primary guarantee; RLS is defense in depth.
 *
 * Note: PGlite connects as a Postgres superuser, which by design *bypasses* RLS, so
 * the in-sandbox proof of tenant isolation is the application-level test. The GUC is
 * still set here so the exact same code path enforces RLS on a real cluster where the
 * app connects as a non-superuser role.
 */
export async function withWorkspace<T>(
  db: Database,
  workspaceId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_workspace', ${workspaceId}, true)`);
    return fn(tx as unknown as Database);
  });
}
