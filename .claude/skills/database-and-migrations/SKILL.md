---
name: database-and-migrations
description: Open when changing the DB — adding a table/column, writing a migration, adding RLS for a new tenant table, or debugging PGlite-vs-Postgres behavior.
---

## When to use

- Adding a table or column, changing a type, adding an index.
- Writing a new numbered `migrations/*.sql` file.
- Adding a new tenant-owned table and wiring its RLS policy.
- A query typechecks but fails at runtime, or "works in tests but not prod" — usually a `schema.ts` ↔ `migrations/*.sql` drift, or an RLS/superuser difference between PGlite and a real cluster.
- Deciding where a primary key comes from (answer: app-side `newId()`, never the DB).

## Mental model

There are **two hand-maintained sources of truth that must agree**, and Drizzle does NOT auto-reconcile them:

1. `apps/api/src/db/schema.ts` — the **typed query surface**. Drizzle reads this to give services `ctx.db.select()/insert()` with column types. It knows nothing about RLS.
2. `apps/api/migrations/*.sql` — the **canonical applied SQL**, hand-authored (ADR-002/003) specifically so it can carry the RLS policies and be read in code review. This is what actually runs against the database.

`drizzle-kit generate` (`pnpm db:generate`) can emit a diff SQL into `migrations/`, but the RLS `DO $$ … $$` block is hand-written and Drizzle will not regenerate it — so **you edit both files by hand and keep them mirrored**. The migration runner (`migrate.ts`) applies each `.sql` file whole, in filename order, against either driver.

One schema, **two drivers** (`client.ts`, ADR-002): `DATABASE_URL` set → node-postgres against a real cluster; unset → PGlite (Postgres-in-WASM, in-process) for dev/test. Query code is byte-identical across both. The catch: **PGlite connects as superuser and bypasses RLS**; a real non-superuser cluster enforces it. So RLS is defense-in-depth on top of the primary guarantee — every service query filters by `workspace_id` explicitly.

## Key files

- `apps/api/src/db/schema.ts` — Drizzle table defs + `export const schema` (the registry passed to `drizzle()`) + `$inferSelect` row types (`NoteRow`, etc.). Edit here for the typed surface.
- `apps/api/migrations/0001_init.sql` — the only migration today. Tables, indexes, and the RLS `DO $$` loop at the bottom (lines ~120-135). Edit/add here for what actually runs.
- `apps/api/src/db/migrate.ts` — `migrationSql()` reads+sorts `migrations/*.sql`; `applyMigrationsPglite` / `applyMigrationsPostgres` apply each file **whole** (no `;`-splitting — `DO $$` blocks would break). CLI = `pnpm db:migrate`.
- `apps/api/src/db/client.ts` — `createDb()` picks the driver; `withWorkspace(db, wsId, fn)` opens a txn and runs `set_config('app.current_workspace', wsId, true)` so RLS policies resolve.
- `apps/api/src/tenant.ts:runTenant` — request-level wrapper over `withWorkspace`; hands services a `Ctx{db,principal,workspaceId}`.
- `apps/api/src/lib/ids.ts` — `newId()` = `randomUUID()` (all PKs are app-generated); `isUuid()` validates client-supplied ids; `newSecret()` for token secrets.
- `apps/api/drizzle.config.ts` — points drizzle-kit at `schema.ts`, output `./migrations`. Dialect `postgresql`.
- `apps/api/src/env.ts` — `env.databaseUrl` (driver switch) and `env.pglitePath` (default `.data/iris`).

## Playbook

**Task: add a nullable `pinned_at timestamptz` column to `notes`.**

1. **Edit `schema.ts`** — add the field to the `notes` `pgTable`, matching the SQL column name:
   ```ts
   // apps/api/src/db/schema.ts, inside notes {...}
   pinnedAt: timestamp('pinned_at', { withTimezone: true }),
   ```
   `NoteRow` (`typeof notes.$inferSelect`) now carries `pinnedAt`, so services and `serialize.ts` see it typed.

2. **Add a new numbered migration** — never edit `0001_init.sql` after it has shipped. Create `apps/api/migrations/0002_notes_pinned.sql`:
   ```sql
   ALTER TABLE notes ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
   ```
   Files apply in **filename sort order**, so zero-pad the prefix (`0002_`, `0003_`…). Use `IF NOT EXISTS` / `IF EXISTS` guards — migrations may re-run against an existing PGlite `.data/iris`.

3. **Apply it.** Dev/PGlite: `pnpm --filter @iris/api db:migrate`. Tests apply all migrations to a fresh PGlite automatically via `applyMigrationsPglite` — just `pnpm --filter @iris/api test`.

4. **Verify** the two files agree: same column name (`pinned_at`), same type/nullability. Typecheck: `pnpm --filter @iris/api typecheck`.

**Task variant: add a NEW tenant-owned table `note_links`.**

1. `schema.ts`: define the `pgTable` with a non-null `workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' })`, PK `uuid('id').primaryKey()`, and add the table to the `export const schema = { … }` registry (or `ctx.db` won't know it).
2. New migration file — table DDL **plus** the RLS policy. Copy the pattern from `0001_init.sql`:
   ```sql
   CREATE TABLE IF NOT EXISTS note_links (
     id           uuid PRIMARY KEY,
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     -- …
     created_at   timestamptz NOT NULL DEFAULT now()
   );
   ALTER TABLE note_links ENABLE ROW LEVEL SECURITY;
   ALTER TABLE note_links FORCE ROW LEVEL SECURITY;
   CREATE POLICY workspace_isolation ON note_links
     USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
     WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);
   ```
   (Or add `'note_links'` to the `ARRAY[...]` in the `DO $$` loop if you keep that style — either produces the same policy.)
3. In service code, **always** set `id: newId()` and `workspaceId: ctx.workspaceId` on insert; filter every select by `eq(table.workspaceId, ctx.workspaceId)` — mirror `note-write.ts:loadNote`. RLS is a backstop, not the filter.

## Invariants & gotchas

- **schema.ts and migrations/*.sql are mirrored by hand.** Drizzle does not sync them for you; a mismatch (column in one, not the other) typechecks fine and then explodes at runtime. Change both, same names.
- **Column naming:** `schema.ts` uses camelCase TS keys mapping to snake_case SQL (`bodyMd` → `body_md`). The **string arg** to `text()/uuid()/timestamp()` is the real DB column and must match the SQL exactly.
- **Never edit a shipped migration.** Add a new higher-numbered file. Zero-pad prefixes so sort order = apply order.
- **Migrations apply whole, not statement-split.** `migrate.ts` runs each file in one `exec`/`query`. That's deliberate — the RLS `DO $$ … $$` block contains `;` and must not be naively split. Keep multi-statement files valid as a single batch.
- **Every tenant row has `workspace_id` non-null** (ADR-003). New tenant tables must have it + FK to `workspaces` `ON DELETE CASCADE`. Non-tenant/bootstrap tables (`users`, `agent_tokens`) are deliberately **exempt from RLS** — they're read to decide *which* workspace a request is before any tenant context exists (see the comment at `0001_init.sql:116-119`). Don't put them under `workspace_isolation`.
- **PGlite bypasses RLS (superuser); prod enforces it.** RLS bugs will NOT show up in local PGlite dev or in tests. The in-repo proof of isolation is the application-level tenant-isolation test, and the app-layer `where workspace_id = …` filter is the real guarantee. Treat RLS as defense-in-depth, and remember `current_setting('app.current_workspace', true)` returns NULL when unset → an unscoped connection sees nothing (fail closed).
- **RLS only holds inside `withWorkspace`/`runTenant`.** The GUC is set per-transaction with the local flag (`set_config(..., true)`). Any raw query outside that transaction has no tenant context. Services should only ever touch `ctx.db`.
- **PKs are app-generated with `newId()` (randomUUID).** No DB `default gen_random_uuid()`, no serial — so you must set `id` on every insert. Client-supplied note ids are accepted only after `isUuid()` (`notes.ts:34`), for local-first creation.
- **`devices.id` is `text`, not `uuid`** — it's a client installation id. Don't assume every PK is a UUID.
- **Every note mutation must call `recordVersionAndActivity` (`note-write.ts:22`)** — it writes the `note_versions` snapshot + append-only `activity_log` row that make agent actions attributable/reversible (pillar #2). If you add a note-writing path, route it through this, don't insert into `notes` bare.
- **Version columns are `integer NOT NULL`** and drive sync's optimistic concurrency (base_version → 409). The `notes_sync_idx` on `(workspace_id, updated_at, id)` backs the change-feed cursor (ADR-005) — keep it if you touch the notes table.
- **`activity_log` is append-only.** "Undone" is derived from the existence of a row with `undo_of_id` pointing at the original; never UPDATE/DELETE originals.
- **Pins:** drizzle-orm 0.45.2, drizzle-kit 0.31.10, pg 8.22, PGlite 0.5.4, TS 5.9.3. Don't bump casually.
