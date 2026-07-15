---
name: add-an-api-route
description: Open when adding, extending, or debugging a REST endpoint on apps/api — the end-to-end recipe from zod schema to client method to route to service to test.
---

## When to use

- You need a new endpoint (search, pin, bulk-op, a new resource) exposed to the mobile app or to agents.
- You're adding a field/param to an existing route and must thread it through shared → client → route → service → serialize.
- Symptoms that land here: a handler 401s for a logged-in user, an agent gets 403, a response leaks `Date`/`null` oddly, tenant isolation fails, `@iris/shared` types don't line up between app and api, or a mutation doesn't show in the activity feed / can't be undone.

## Mental model

One Fastify service, every tenant route workspace-scoped. The request lifecycle is fixed: `route (app.ts)` → `authGuard` sets `req.principal` (user JWT or agent token) → `tenant(req, fn)` calls `runTenant` which opens ONE transaction, sets the RLS GUC `app.current_workspace`, and hands the service a `Ctx{db, principal, workspaceId}` → the service filters **every** query by `ctx.workspaceId` and returns already-serialized wire types → the handler returns a plain object that Fastify sends as JSON. Contracts live once, in `packages/shared` zod schemas; the api validates against them and the client infers types from them, so a shape change is a compile error on both ends. Errors are thrown as `HttpError` and a single `setErrorHandler` turns them into `{ error: { code, message, conflict? } }`; a thrown `ZodError` becomes a 400 automatically. Two orthogonal guards protect routes: `requireScope(ctx, 'notes:read'|'notes:write')` (what an agent token may do; users implicitly hold all scopes) and `requireUser(ctx.principal)` (user-only actions like token mgmt, billing, undo, device registration).

## Key files

- `packages/shared/src/schemas.ts` — zod source of truth. Each shape is `export const Foo = z.object({...})` + `export type Foo = z.infer<typeof Foo>`. Timestamps cross the wire as ISO strings. Re-exported by `packages/shared/src/index.ts` (`export * from './schemas'`).
- `packages/shared/src/api-client.ts` — `createApiClient()` returns the typed method bag; each method calls `request<T>(method, path, body?)`. Add your method inside that returned object; import its response type at the top from `./schemas`.
- `apps/api/src/app.ts` — `buildApp(bundle)`; all routes registered here. `guarded = { preHandler: authGuard }`; `tenant(req, fn)` = `runTenant(app.db, principalOf(req), fn)`; local `requireUser(p)`; `requireScope` imported from `./context`.
- `apps/api/src/context.ts` — `Ctx{db, principal, workspaceId}` and `requireScope(ctx, scope)` (throws 403).
- `apps/api/src/tenant.ts` — `runTenant(db, principal, fn)`; the ONE place a tx opens and the RLS GUC is set. Services never do this themselves.
- `apps/api/src/services/notes.ts` — the model service: `(ctx, ...)` args, every query `and(eq(notes.workspaceId, ctx.workspaceId), ...)`, returns `serializeNote(row)`.
- `apps/api/src/services/note-write.ts` — `loadNote(ctx, id)` and `recordVersionAndActivity(ctx, note, action, undoOfId?)` — the choke point every note **mutation** must call (version snapshot + activity_log row).
- `apps/api/src/serialize.ts` — `serializeNote` / `serializeVersion` / etc. Row (Date, hashes) → wire (ISO, no secrets). The only place that translation happens.
- `apps/api/src/lib/errors.ts` — `HttpError` + helpers `badRequest/unauthorized/forbidden/notFound/paymentRequired/conflict`. Throw these; don't hand-build error bodies.
- `apps/api/src/lib/ids.ts` — `newId()` (uuid v4), `isUuid()`, `newSecret()`.
- `apps/api/test/helpers.ts` — `makeApp()` (fresh PGlite per file), `call(app, method, path, {token, body})`, `signUp(app)`.
- `apps/api/src/db/schema.ts` + `migrations/*.sql` — hand-kept in sync; only touch these if your route needs a new column (see gotchas).

## Playbook — add `GET /v1/notes/search?q=` (read-only, no migration)

**1. Define the response in `packages/shared/src/schemas.ts`** (reuse `Note`; a request body isn't needed for a GET query):

```ts
export const NoteSearchResponse = z.object({
  notes: z.array(Note),
});
export type NoteSearchResponse = z.infer<typeof NoteSearchResponse>;
// (Fine to reuse NoteListResponse instead; a distinct type shown here for the recipe.)
```

No `index.ts` edit needed — it already `export * from './schemas'`.

**2. Add a client method in `packages/shared/src/api-client.ts`** (inside the object returned by `createApiClient`, near the other `--- Notes ---` methods). Add `NoteSearchResponse` to the top `import type { ... } from './schemas'` list, then:

```ts
searchNotes: (q: string) =>
  request<NoteSearchResponse>('GET', `/v1/notes/search?q=${encodeURIComponent(q)}`),
```

**3. Write the service `searchNotes(ctx, q)` in `apps/api/src/services/notes.ts`** — filter by `ctx.workspaceId`, exclude tombstones, serialize:

```ts
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm'; // add ilike, or

export async function searchNotes(ctx: Ctx, q: string): Promise<Note[]> {
  const term = `%${q}%`;
  const rows = await ctx.db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.workspaceId, ctx.workspaceId), // REQUIRED on every tenant query
        isNull(notes.deletedAt),
        or(ilike(notes.title, term), ilike(notes.bodyMd, term)),
      ),
    )
    .orderBy(desc(notes.updatedAt));
  return rows.map(serializeNote);
}
```

**4. Register the route in `apps/api/src/app.ts`** (under `── Notes ──`). Read → `requireScope(ctx, 'notes:read')`:

```ts
app.get('/v1/notes/search', guarded, (req) =>
  tenant(req, async (ctx) => {
    requireScope(ctx, 'notes:read');
    const q = (req.query as { q?: string }).q ?? '';
    return { notes: await notesService.searchNotes(ctx, q) };
  }),
);
```

- `guarded` = auth (sets `req.principal`); omit it and `tenant()`→`principalOf` throws 401.
- Body routes instead do `const input = SomeRequest.parse(req.body)` — a bad body throws `ZodError` → 400 for free.
- Non-200 success: `reply.status(201)` then `return { note }` (see `POST /v1/notes`).

**5. Add a test** `apps/api/test/notes-search.test.ts` (vitest; mirror `versioning.test.ts` / `tenant-isolation.test.ts`):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

describe('notes search', () => {
  let t: TestApp;
  beforeAll(async () => { t = await makeApp(); });
  afterAll(() => t.close());

  it('matches title or body and stays inside the workspace', async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);
    await call(t.app, 'POST', '/v1/notes', { token: alice.token, body: { title: 'Groceries', bodyMd: 'milk and eggs' } });
    await call(t.app, 'POST', '/v1/notes', { token: bob.token, body: { title: 'Groceries', bodyMd: 'bob milk' } });

    const res = await call(t.app, 'GET', '/v1/notes/search?q=milk', { token: alice.token });
    expect(res.status).toBe(200);
    expect(res.json.notes).toHaveLength(1);              // never sees Bob's note
    expect(res.json.notes[0].bodyMd).toContain('milk and eggs');
  });
});
```

Run: `pnpm --filter @iris/api test`. Typecheck both ends: `pnpm -r typecheck` (shape drift between shared and api surfaces here).

**Variant — a note-mutating endpoint (e.g. `pin`)**: it must go through the version/activity choke point. Follow `updateNote` in `services/notes.ts`: `loadNote(ctx, id)` → 404 if missing/deleted → if it accepts `baseVersion`, `throw conflict(msg, serializeNote(current))` on mismatch → `update(...).set({ ...changes, version: current.version + 1, updatedAt: new Date() })` → `await recordVersionAndActivity(ctx, note, 'note.update')`. A new *column* (e.g. `pinned`) additionally requires: add it to `db/schema.ts` AND the SQL in `migrations/`, plus `serializeNote` + the `Note` zod schema. Route uses `requireScope(ctx, 'notes:write')`.

## Invariants & gotchas

- **Filter every tenant query by `ctx.workspaceId`.** `runTenant` sets the RLS GUC, but isolation is proven at the app layer (`test/tenant-isolation.test.ts`) so it holds across DB drivers — never rely on RLS alone. Missing this is the #1 way to leak across workspaces.
- **Pick the right guard.** Anything an agent may do → `requireScope(ctx, 'notes:read'|'notes:write')`. User-only (token issuance, billing checkout, device registration, undo) → `requireUser(ctx.principal)`. Note the signatures differ: `requireScope(ctx, scope)` vs `requireUser(principal)`. Users pass `requireScope` automatically (they hold all scopes).
- **`workspaceId` comes from the principal, never the caller.** It's `ctx.workspaceId`; do not read it from body/query/params.
- **Every note mutation calls `recordVersionAndActivity`.** Skipping it silently breaks attribution, the activity feed, and undo (pillar #2). If you mutate a note anywhere, you owe a version snapshot + activity row.
- **Optimistic concurrency, never silent overwrite.** Update/delete take `baseVersion`; on mismatch `throw conflict(msg, serializeNote(current))` (409 carries the server note in `error.conflict`). Client surfaces it via `ApiRequestError.isConflict`.
- **Serialize at the boundary.** Services return wire types via `serialize*` (Date→ISO, secrets stripped). Never return a raw Drizzle row from a handler — you'll leak `Date` objects or hashed columns and break the client's zod types.
- **Don't open a transaction or set the GUC in a service.** You're already inside `runTenant`'s tx — use `ctx.db` for every read and write so the request stays atomic.
- **Throw `HttpError` helpers, don't build error bodies.** `setErrorHandler` in `app.ts` owns the envelope. `ZodError` → 400 `validation_error`; anything else → 500. So `SomeRequest.parse(req.body)` is your validation — don't hand-roll it.
- **Response wrapping is by convention.** Single entity → `{ note }`; collection → `{ notes }` / `{ versions }`. Match the zod response schema exactly or the client's `request<T>` cast lies.
- **Static vs param routes.** Fastify (find-my-way) resolves static segments before parametric, so `/v1/notes/search` wins over `/v1/notes/:id` regardless of registration order — but don't introduce a literal segment that could ever be a real note id.
- **Shared package uses extensionless relative imports** (`from './schemas'`), TS pinned at 5.9.3. Import wire types in api from `@iris/shared`; add new schemas to `schemas.ts` (auto re-exported) — don't touch `index.ts`.
- **Tests use a fresh PGlite per file** (`makeApp()`); `call()` injects requests without a socket. Always assert cross-workspace isolation for any new read/list endpoint (copy the Alice/Bob pattern).
