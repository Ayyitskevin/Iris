/**
 * Server entrypoint. On the PGlite dev path we auto-apply migrations so `pnpm dev:api`
 * boots with a ready database and zero setup. On the production (node-postgres) path,
 * run `pnpm db:migrate` against the cluster first.
 */
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createDb, type DbBundle } from './db/client';
import { applyMigrationsPglite } from './db/migrate';
import { buildApp } from './app';
import { env } from './env';

async function main(): Promise<void> {
  let bundle: DbBundle;
  if (env.databaseUrl) {
    bundle = createDb();
  } else {
    // PGlite persists to a directory; make sure it exists before opening.
    mkdirSync(env.pglitePath, { recursive: true });
    const client = new PGlite(env.pglitePath);
    await applyMigrationsPglite(client);
    bundle = createDb(client);
  }

  const app = await buildApp(bundle);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info(
    `Iris API listening on :${env.port} (db: ${bundle.kind}, auth: ${env.authProvider})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
