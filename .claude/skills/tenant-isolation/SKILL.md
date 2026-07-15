---
name: tenant-isolation
description: Read before writing or reviewing any query, table, migration, or service — how workspace scoping is enforced end to end and how to avoid punching a hole in it.
---

## When to use

- Adding/changing any query in `apps/api/src/services/*` — before you write `.select()`/`.update()`/`.delete()`.
- Creating a new tenant table or migration (`apps/api/migrations/*`, `src/db/schema.ts`).
- Adding a route in `apps/api/src/app.ts` that touches tenant data.
- A test shows one workspace seeing another's rows, or a query returns rows it shouldn't.
- Anything auth-bootstrap related (login, agent-token verification) that reads before a workspace is known.
- Reviewing a PR: the single question "can workspace A read/write workspace B's data?" lives here.

## Mental model

Every tenant row carries a non-null `workspace_id`. A request resolves to exactly one `Principal` (user JWT **or** agent token), which is bound to exactly one `workspaceId` that the caller cannot choose. There are **two layers** of defense (ADR-003, `docs/DECISIONS.md`):

1. **Application layer (primary, always in force).** Every service query filters `where workspace_id = ctx.workspaceId`. This is the guarantee that holds regardless of DB driver, and it is what the isolation test actually proves.
2. **Postgres RLS (defense in depth).** Policies gate every row by the per-transaction GUC `app.current_workspace`. Even a query that forgets the `WHERE` returns nothing across the boundary — **on a real cluster where the app connects as a non-superuser**. PGlite (dev/test) connects as superuser and *bypasses RLS by design*, so RLS is invisible locally. Never lean on RLS as your only filter.

The choke point is `runTenant()` → `withWorkspace()`: one transaction, GUC set, `Ctx{db,principal,workspaceId}` handed to services. Services never open transactions or set the GUC themselves.

Exception: `users` and `agent_tokens` are **NOT** under RLS. They are the auth-bootstrap tables — read to establish *which* workspace a request belongs to, before any tenant context exists. They stay app-layer scoped.

## Key files

- `apps/api/src/tenant.ts` → `runTenant(db, principal, fn)` — opens the tenant transaction and builds `Ctx`. Every data route goes through it (via `tenant()` helper in `app.ts:99`).
- `apps/api/src/db/client.ts` → `withWorkspace(db, workspaceId, fn)` — `db.transaction()` + `set_config('app.current_workspace', workspaceId, true)`. The header comment explains the PGlite-superuser-bypasses-RLS caveat (lines 50-60).
- `apps/api/src/db/client.ts` → `createDb()` — driver selection: `DATABASE_URL` set → node-postgres (prod, non-superuser, RLS bites); unset → PGlite in-process (dev/test, superuser, RLS bypassed).
- `apps/api/src/context.ts` → `Ctx` interface + `requireScope(ctx, scope)`. `workspaceId` is *the* tenant boundary; derived from the principal, not the caller.
- `apps/api/src/auth/provider.ts` → `Principal` — `{type, id, name, workspaceId, scopes}`; one workspace per identity.
- `apps/api/src/middleware/authenticate.ts` → `resolvePrincipal(db, authHeader)` — the auth-bootstrap read. Uses the **base db** (pre-tenant), looks users up by `id`, agent tokens via `verifyAgentToken`.
- `apps/api/src/services/agents.ts` → `verifyAgentToken(db, presented)` — runs on base db, filters `agent_tokens` by token id only (no workspace yet); comment at line 82 explains why it must not be under RLS.
- `apps/api/migrations/0001_init.sql` (lines 108-135) — RLS policy loop over `workspace_members, notes, note_versions, activity_log, devices, subscriptions`. `ENABLE` + `FORCE` + `workspace_isolation` policy. The comment (lines 116-119) documents the `users`/`agent_tokens` exclusion.
- `apps/api/src/services/notes.ts` + `services/note-write.ts` → the canonical example of app-layer scoping (`loadNote` filters by `workspaceId`; every query pairs `eq(notes.id, id)` with `eq(notes.workspaceId, ctx.workspaceId)`).
- `apps/api/test/tenant-isolation.test.ts` — the authoritative proof: A cannot read/update/delete B; an agent token cannot cross its workspace.

## Playbook

**Task: add a new tenant-scoped query to a service (the 90% case).** Say we add `findNotesInFolder`.

1. **Filter by `ctx.workspaceId` in the same `where` as any id/predicate.** Follow `note-write.ts:loadNote`:
   ```ts
   export async function findNotesInFolder(ctx: Ctx, folder: string): Promise<Note[]> {
     const rows = await ctx.db
       .select()
       .from(notes)
       .where(and(
         eq(notes.workspaceId, ctx.workspaceId),   // ← never omit
         eq(notes.folder, folder),
         isNull(notes.deletedAt),
       ));
     return rows.map(serializeNote);
   }
   ```
   Use `ctx.db` (the tenant transaction), never `app.db` / a fresh handle. Never accept a `workspaceId` argument from the caller — read it off `ctx`.

2. **Wire the route through `tenant()` + `requireScope`.** In `app.ts`, mirror the existing notes routes (`app.ts:139-151`):
   ```ts
   app.get('/v1/notes/folder/:folder', guarded, (req) =>
     tenant(req, async (ctx) => {
       requireScope(ctx, 'notes:read');
       return { notes: await notesService.findNotesInFolder(ctx, (req.params as {folder:string}).folder) };
     }),
   );
   ```
   `guarded` runs `authGuard` → `resolvePrincipal`; `tenant()` calls `runTenant(app.db, principalOf(req), fn)`. Do not call `withWorkspace`/`db.transaction` yourself.

3. **Cross-workspace reads must look like "not found", not "forbidden".** A row in another workspace should be invisible: `loadNote` returns `undefined` → services throw `notFound()` (see `notes.ts:29`, and the test expecting `404` at `tenant-isolation.test.ts:34`). Returning 403 would leak existence.

4. **If you added a new table, add it to RLS.** In the migration, append the table name to the `ARRAY[...]` loop in `0001_init.sql:123` so it gets `ENABLE/FORCE ROW LEVEL SECURITY` + the `workspace_isolation` policy. The table needs a non-null `workspace_id uuid ... REFERENCES workspaces(id) ON DELETE CASCADE`. Keep `src/db/schema.ts` in sync (hand-authored SQL mirrors the Drizzle schema).

5. **Prove it.** Extend `test/tenant-isolation.test.ts`: sign up `alice` and `bob`, have alice create data, assert bob's principal (and bob's agent token) get `404`/empty list. This test is the definition of the invariant being true — run `pnpm --filter @iris/api test`.

## Invariants & gotchas

- **Every tenant row has a non-null `workspace_id` with an FK to `workspaces` and `ON DELETE CASCADE`.** No exceptions among tenant tables. Auth-bootstrap tables (`users`, `agent_tokens`) are the *only* tables without their own RLS.
- **Every service query filters by `ctx.workspaceId` at the app layer.** RLS is defense in depth, not the primary guarantee. Do not "rely on RLS" to skip the `WHERE` — in dev/test (PGlite superuser) RLS is fully bypassed, so an unfiltered query silently reads across tenants and *the isolation test may still pass by accident if you only test happy paths*. The app-layer filter is what the test actually exercises.
- **PGlite bypasses RLS; production does not.** Locally you cannot observe RLS working. This means: (a) never let RLS be your sole line of defense, and (b) if a query is wrong app-side, prod behavior differs from dev. The `withWorkspace` GUC is still set locally so the exact same code path enforces RLS on a real cluster (`client.ts:56-59`).
- **`workspaceId` comes from the `Principal`, never from the request body/query/params.** `runTenant` uses `principal.workspaceId` (`tenant.ts:17`). A route that reads a workspace id from user input is a boundary break.
- **Services must not open transactions or set the GUC.** They receive `ctx.db` — already the per-request tenant transaction — and use it throughout (`notes.ts` header comment, lines 6-7). Opening a second connection escapes the tenant transaction and the GUC.
- **The GUC name is `app.current_workspace` in code but the RLS policy in `0001_init.sql` reads `current_setting('app.current_workspace', true)`.** The `, true` (missing_ok) makes it `NULL` when unset → policy fails closed (un-scoped connection sees nothing). Do not drop the `true`, and keep the string identical on both sides. (Historical note: ADR-003 prose calls it `iris.workspace_id`; the shipped code uses `app.current_workspace` — trust the code.)
- **Auth-bootstrap reads run on the base db, pre-tenant.** `resolvePrincipal` and `verifyAgentToken` intentionally query `users`/`agent_tokens` with no workspace filter because the workspace is unknown until the token/session is resolved. This is *why* those two tables are excluded from RLS. Do not add them to the RLS loop — you would deadlock auth (an unset GUC would hide the very rows needed to set it).
- **Anything read from `agent_tokens` after auth must still be app-scoped.** `listAgentTokens`/`revokeAgentToken` (`agents.ts:51,60`) filter by `ctx.workspaceId` even though the table has no RLS. Skipping that filter would list/revoke other workspaces' tokens.
- **`FORCE ROW LEVEL SECURITY` matters:** without it, the table owner bypasses RLS even as a non-superuser. The migration sets both `ENABLE` and `FORCE` (`0001_init.sql:127-128`). Keep both when adding tables.
- **Cross-workspace access returns 404, not 403** (see gotcha in Playbook step 3) — enforced by `loadNote` returning `undefined` and services throwing `notFound()`.
