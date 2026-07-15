/**
 * Migration runner. Applies every `migrations/*.sql` file, in filename order, as a
 * whole (they contain `DO $$ … $$` blocks that must not be naively split on `;`).
 *
 * Used by the test harness (against a fresh PGlite) and by `pnpm db:migrate`
 * (against PGlite or a real cluster).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { env } from '../env';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

export function migrationSql(): { name: string; sql: string }[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(`${migrationsDir}/${name}`, 'utf8') }));
}

/** Apply all migrations to a PGlite instance (dev/test path). */
export async function applyMigrationsPglite(client: PGlite): Promise<void> {
  for (const { sql } of migrationSql()) {
    await client.exec(sql);
  }
}

/** Apply all migrations to a real cluster via node-postgres (production path). */
async function applyMigrationsPostgres(connectionString: string): Promise<void> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });
  try {
    for (const { name, sql } of migrationSql()) {
      console.log(`applying ${name}`);
      await pool.query(sql);
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (env.databaseUrl) {
    await applyMigrationsPostgres(env.databaseUrl);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(env.pglitePath, { recursive: true });
    const client = new PGlite(env.pglitePath);
    await applyMigrationsPglite(client);
    await client.close();
  }
  console.log('migrations applied');
}

// Run as a CLI when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
