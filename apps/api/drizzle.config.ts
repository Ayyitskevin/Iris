import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit is used to *evolve* the schema going forward (`pnpm db:generate`).
 * The canonical applied SQL lives in `migrations/` and is hand-authored so it can
 * carry RLS policies and be read in review (see src/db/schema.ts + ADR-003).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
});
