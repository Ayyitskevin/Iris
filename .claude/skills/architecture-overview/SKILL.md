---
name: architecture-overview
description: Start here when you're new to Iris or unsure where a feature lives — the whole-repo map and how one API request flows from route to database.
---

## When to use

- You're touching this repo for the first time and need the mental map.
- You don't know which file owns a behavior (auth? tenancy? versioning? sync? billing?).
- You're adding a new endpoint and want the canonical route→service→serialize pattern.
- You need to know which of the three product pillars a change serves (and whether it's in scope).
- You're about to change cross-cutting plumbing (the request lifecycle, the tenant transaction, the error envelope) and need to know what will break.

## Mental model

Iris is a notes app where **AI agents are first-class actors** (own identity, scoped token, audit trail), built for one operator supervising several agents. The whole thing is **one pnpm monorepo, one TypeScript language end-to-end**: `apps/api` (Fastify + Drizzle + Postgres — the system of record), `apps/mobile` (Expo + Legend-State local-first client), and `packages/shared` (zod schemas + typed client imported by both, so client/server payloads can't drift — ADR-000/001).

The API is **one Fastify service, every route workspace-scoped** (ADR-006). One request flows: **route** (`app.ts`) → **`authGuard`** resolves a `Principal` (user JWT _or_ agent token, both bound to exactly one `workspaceId`) → **`runTenant`** opens ONE transaction, sets the RLS GUC `app.current_workspace`, and hands the service a `Ctx{db, principal, workspaceId}` → the **service** filters every query by `workspaceId` → **`serialize.ts`** maps DB rows to wire types. Errors are thrown as `HttpError` and become `{error:{code,message,conflict?,operationId?}}`; only REST `version_conflict` errors carry the optional authoritative note, while an `idempotency_key_reused` response carries its operation id instead.

Two load-bearing invariants ride on top: **every workspace-owned child row carries `workspace_id`** (ADR-003), and **every note mutation calls `recordVersionAndActivity`** — a `note_versions` snapshot + an append-only `activity_log` row — which makes agent actions attributable, auditable, and forward-restorable for the fields the snapshot records (pillar #2, ADR-008/009). Folder/tag parity remains a tracked correctness gap. The database backend swaps by env: **PGlite** (Postgres-in-WASM, in-process, zero infra) when `DATABASE_URL` is unset, **node-postgres** when set (ADR-002) — same schema, same query code.

## How the three pillars map to code

1. **Ownership / local-first + Markdown** — notes store canonical `body_md` text (`db/schema.ts:notes`), `apps/mobile` Legend-State edits apply offline, and `GET /v1/export` (`app.ts` → `services/export.ts:collectExport`) zips `.md` files via `archiver`.
2. **Agents as attributable/reversible/bounded actors** — `Principal.type: 'user'|'agent'` (`auth/provider.ts`); scoped hashed tokens (`services/agents.ts`, `db/schema.ts:agentTokens`); `requireScope` (`context.ts`); every note write is logged to `activity_log`, and the currently snapshotted content fields are forward-undoable (`services/activity.ts:undoActivity`). Folder/tag parity is still a tracked correctness gap.
3. **Sync that surfaces conflicts** — `services/sync.ts` uses a commit-serialized
   database cursor plus request-bound durable receipts. Version mismatches are typed
   per-operation HTTP 200 results; incompatible `opId` reuse is a loud HTTP 409
   (ADR-005/011/012).

## Key files

- `apps/api/src/app.ts` — `buildApp(bundle)`: the whole route table + error handler. Read this first; it's the index of every endpoint. Helpers: `authGuard`, `principalOf`, `requireUser`, `tenant()` wrapper.
- `apps/api/src/middleware/authenticate.ts` — `resolvePrincipal(db, authHeader)`: bearer token → `Principal`. Agent token (`iris_at_…`) vs. user session JWT; both yield one `workspaceId`.
- `apps/api/src/auth/provider.ts` — the `Principal` shape + `AuthProvider` seam (ADR-004). `signUp`/`signIn`. Local provider shipped; managed provider (Clerk/Supabase) is a drop-in by env.
- `apps/api/src/tenant.ts` — `runTenant(db, principal, fn)`: opens the per-request transaction, builds `Ctx`. THE isolation boundary.
- `apps/api/src/db/client.ts` — `createDb()` (driver selection by `DATABASE_URL`) + `withWorkspace()` (sets `app.current_workspace` GUC for RLS).
- `apps/api/src/context.ts` — `Ctx` interface + `requireScope(ctx, scope)`. `workspaceId` is derived from the principal, never chosen by the caller.
- `apps/api/src/services/*.ts` — one file per domain, plus `note-write.ts` for
  workspace load, lost-CAS conflicts, and version/activity recording.
- `apps/api/src/serialize.ts` — `serializeNote`/`serializeVersion`/`serializeActivity`/… Row→wire mappers; the ONE place Date→ISO and secret-stripping happens.
- `apps/api/src/lib/errors.ts` — the uniform error factories, including distinct
  `version_conflict` and `idempotency_key_reused` 409s.
- `apps/api/src/db/schema.ts` + `migrations/*.sql` — typed and applied schema
  surfaces. The checksummed runner applies pending files once, rejects ambiguous
  legacy state, and revalidates the current-head 0003 artifacts on later runs; every
  tenant table has `workspaceId`.
- `packages/shared/src/schemas.ts` + `api-client.ts` — zod request/response schemas and the typed client; imported by both api and mobile via `@iris/shared`.

## Playbook

Most common task: **add a new workspace-scoped endpoint**. Worked example — `GET /v1/notes/:id/versions` already exists; here's the pattern to copy for a new read/write route.

1. **Define the wire types** in `packages/shared/src/schemas.ts` (zod request + inferred response type), export from `index.ts`. The client and server now share one definition.
2. **Add the service function** in the relevant `apps/api/src/services/*.ts`. It takes `ctx: Ctx` first and filters EVERY query by `ctx.workspaceId`:
   ```ts
   export async function listVersions(ctx: Ctx, id: string) {
     const note = await loadNote(ctx, id); // loadNote already scopes to workspaceId
     if (!note) throw notFound('Note not found');
     return ctx.db
       .select()
       .from(noteVersions)
       .where(and(eq(noteVersions.noteId, id), eq(noteVersions.workspaceId, ctx.workspaceId)))
       .orderBy(desc(noteVersions.version));
   }
   ```
   If it mutates a note, it MUST call `recordVersionAndActivity(ctx, note, 'note.<action>')` (see `services/notes.ts:updateNote`).
3. **Register the route** in `app.ts`, guarded, inside the `tenant()` wrapper. The wrapper resolves the principal and opens `runTenant`; you just check scope and call the service:
   ```ts
   app.get('/v1/notes/:id/versions', guarded, (req) =>
     tenant(req, async (ctx) => {
       requireScope(ctx, 'notes:read'); // or requireUser(ctx.principal) for user-only actions
       const versions = await notesService.listVersions(ctx, (req.params as { id: string }).id);
       return { versions: versions.map(serializeVersion) };
     }),
   );
   ```
   `guarded = { preHandler: authGuard }`. Use `requireScope(ctx, 'notes:read'|'notes:write')` for agent-reachable routes; `requireUser(ctx.principal)` for user-only ones (token issuance, undo, checkout).
4. **Serialize** DB rows to wire shape in the route (`serialize*` from `serialize.ts`) — never return raw rows (they carry Dates and secrets like token hashes).
5. **Throw `HttpError`** for failures (`notFound()`, `conflict(msg, serverNote)`); the `setErrorHandler` in `app.ts` turns it into `{error:{code,message,conflict?,operationId?}}`. Only `version_conflict` carries `conflict`; `idempotency_key_reused` carries `operationId`. ZodError → 400 automatically.
6. **Run it**: `pnpm dev:api` (PGlite, zero config; health at `GET /health`) and `pnpm test` (Vitest; the DoD tests like `tenant-isolation.test.ts` and agent→undo run here). Spin up a fresh isolated DB per test by passing an explicit `PGlite` to `createDb()` → `buildApp()`.

## Invariants & gotchas

- **Every tenant query filters by `ctx.workspaceId`** — even inside `runTenant`. The RLS GUC is defense-in-depth, NOT your primary guarantee: **PGlite connects as superuser and bypasses RLS** (see `db/client.ts:withWorkspace` comment), so the app-layer `where workspace_id = …` is what the in-sandbox tenant-isolation test actually proves. Forgetting the filter leaks across tenants in dev even though prod RLS would catch it.
- **Never let the caller choose `workspaceId`.** It's derived from the authenticated `Principal` in `resolvePrincipal` and threaded through `Ctx`. No request body or query param sets it.
- **Every note mutation goes through `recordVersionAndActivity`** (`services/note-write.ts`). Skip it and you break attribution, version history, undo, and the sync change-feed simultaneously. There is no "quiet" note write.
- **The activity log is append-only.** Undo does NOT delete or mutate the original entry — it writes a new `note.undo` row with `undoOfId` pointing at the reversed entry, and "undone" is _derived_ from the existence of that row (`services/activity.ts:listActivity`). Restore/undo always produce a NEW head version; history is never rewritten (ADR-008).
- **Optimistic concurrency is version-based and compare-and-swap.** REST update/delete
  reject stale `baseVersion` with HTTP 409; sync returns version mismatches in its HTTP
  200 operation results. Every existing-note update path uses CAS: its UPDATE predicates on the loaded
  version so a post-read race surfaces the authoritative head instead of overwriting or
  violating the version-history unique key.
- **Services never open transactions or set the GUC.** They receive `ctx.db` (already the tenant transaction) and use it throughout. Opening a second transaction inside a request breaks atomicity and the GUC scope.
- **The multi-device billing gate lives in `services/devices.ts:ensureDevice`** (402 `payment_required`) and is enforced only when a signed-in user explicitly calls `POST /v1/devices` for a new workspace-composite device id. `requireRegisteredDevice` never allocates device state: sync rejects an unknown id with 403. Don't add a second registration or billing path to sync.
- **The Stripe webhook (`POST /v1/billing/webhook`) is intentionally unauthenticated** and reads `req.rawBody` (kept by the custom `application/json` content-type parser in `app.ts`) for signature verification. Don't wrap it in `authGuard` or strip the raw body.
- **Pinned versions are load-bearing:** TypeScript `5.9.3`, `archiver` v7, Legend-State v2 (client). `packages/shared` uses **extensionless relative imports**. Passwords and agent tokens are hashed with Node's built-in `scrypt` (`lib/hash.ts`); tokens are shown in plaintext exactly once at issuance, then only the hash is stored.
- **`DATABASE_URL` unset → PGlite at `.data/iris`; set → node-postgres.** Same schema
  and query code (ADR-002). Keep `db/schema.ts` aligned with every hand-authored
  migration; RLS and the migration ledger live outside the Drizzle schema.

## Where to go next

Each pillar/domain has its own file(s); dive from here:

- **Tenancy & RLS** — `tenant.ts`, `db/client.ts:withWorkspace`, ADR-003.
- **Auth & the provider seam** — `auth/provider.ts`, `auth/local-provider.ts`, `middleware/authenticate.ts`, ADR-004.
- **Notes & versioning** — `services/notes.ts`, `services/note-write.ts`, ADR-008.
- **Agents, tokens & scopes** — `services/agents.ts`, `context.ts:requireScope`, ADR-009.
- **Activity feed & undo** — `services/activity.ts`, ADR-009.
- **Sync change-feed & conflicts** — `services/sync.ts`, `sync/coordinator.ts`,
  ADR-005/011/012.
- **Billing & device gate** — `services/devices.ts`, `services/billing.ts`, `services/stripe.ts`, ADR-007.
- **Rationale for any stack choice** — `docs/DECISIONS.md` (ADRs are the source of truth for _why_). Product scope/pillars — `docs/VISION.md`.
