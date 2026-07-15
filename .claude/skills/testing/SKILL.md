---
name: testing
description: Open this when writing or debugging an apps/api test — how makeApp()/call()/signUp() work, the forced PGlite/local/fake-Stripe env, and how to add a DoD-style black-box test.
---

## When to use

- Adding a test for a new or changed API endpoint (`apps/api`).
- Writing a "Definition of Done" proof test (e.g. "prove workspace A can't read workspace B").
- A test fails only under vitest, or you see it hitting a real Postgres / Stripe / socket instead of the in-memory path.
- You need to know why tests share a DB per file, why they run sequentially, or why RLS "doesn't work" in a test.
- Anything about `makeApp()`, `call()`, `signUp()`, `app.inject`, or `pnpm test` in the api package.

This skill is only about the `apps/api` harness. `apps/mobile` (Legend-State) is not covered here.

## Mental model

API tests are **black-box HTTP tests against a real, in-process stack** — no mocks of the DB or services. `makeApp()` boots a fresh `PGlite` (Postgres compiled to WASM, running in the same node process), applies the real SQL migrations, wires it into the real `buildApp()` Fastify factory, and hands you back the app. You drive it with `call()`, which uses `app.inject()` to dispatch requests **without opening a TCP socket**. So a test exercises the exact route → `authGuard` → `runTenant` → service → `serialize` path production uses, just against WASM Postgres instead of a cluster.

Isolation is **per file**: one `makeApp()` in `beforeAll`, one `close()` in `afterAll`, and every `it()` in that file shares that single database. That is why tests within a file must be treated as sequential and why you get a clean tenant by calling `signUp()` (each sign-up mints a brand-new user + workspace) rather than by resetting the DB. `vitest.config.ts` forces `DATABASE_URL=''` and `STRIPE_SECRET_KEY=''`, which is what selects the PGlite driver, the local auth provider, and the fake Stripe gateway — you never touch a network service.

## Key files

- `apps/api/test/helpers.ts` — the whole harness. Three exports:
  - `makeApp(): Promise<TestApp>` (`helpers.ts:14`) — `new PGlite()` → `applyMigrationsPglite(client)` → `createDb(client)` → `buildApp(bundle)` → `app.ready()`. Returns `{ app, close }`; `close()` shuts the app and the DB bundle.
  - `call<T>(app, method, path, { token?, body? }): Promise<{status, json}>` (`helpers.ts:35`) — sets `Authorization: Bearer <token>` and JSON body, dispatches via `app.inject` (no socket). `json` is `res.json()`, or `undefined` if the body didn't parse (e.g. 204, or the zip export).
  - `signUp(app, email?): Promise<{token, workspaceId, userId, email}>` (`helpers.ts:64`) — POSTs `/v1/auth/sign-up` with password `'correct-horse-battery'`, **throws** unless status is 201. Default email is randomized, so each call is a fresh tenant.
- `apps/api/vitest.config.ts` — `include: test/**/*.test.ts`, `environment: node`, `pool: forks`, `fileParallelism: false` (files run one at a time), 30s timeouts, and `env: { NODE_ENV: 'test', DATABASE_URL: '', STRIPE_SECRET_KEY: '', JWT_SECRET: 'test-secret' }`. That env block is what forces the PGlite + local-auth + fake-Stripe path regardless of your shell.
- `apps/api/src/db/migrate.ts` — `applyMigrationsPglite(client)` (`migrate.ts:23`) runs every `migrations/*.sql` file whole via `client.exec` (files contain `DO $$…$$` blocks, so they are **not** split on `;`).
- `apps/api/src/db/client.ts` — `createDb(pglite?)` picks the driver from `env.databaseUrl`; passing the PGlite instance gives the fresh per-file DB. `withWorkspace` sets the `app.current_workspace` GUC. **Note the comment at `client.ts:56`: PGlite connects as superuser and bypasses RLS**, so the in-test isolation proof is application-layer, not RLS.
- `apps/api/src/app.ts` — `buildApp(bundle)` is the factory both tests and the server use. Every guarded route is `guarded` (runs `authGuard`) + `tenant(req, ctx => …)`; errors become `{ error: { code, message, conflict? } }` (`app.ts:72`).
- `apps/api/test/agent-undo.test.ts`, `tenant-isolation.test.ts` — canonical DoD-style examples; copy their shape.

## Playbook

**Task: add a black-box test for an endpoint (worked example — a DoD proof).**

1. Create `apps/api/test/<feature>.test.ts`. Match the file glob `test/**/*.test.ts` or vitest won't pick it up.

2. Boot one app per file and share it across the cases:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

describe('note version conflict is a 409', () => {
  let t: TestApp;
  beforeAll(async () => { t = await makeApp(); });
  afterAll(() => t.close());

  it('a stale baseVersion on update is rejected with the server note', async () => {
    // 1. Fresh tenant. Each signUp() is its own workspace, so cases don't collide.
    const user = await signUp(t.app);

    // 2. Create a note as the operator (user tokens hold every scope).
    const note = (
      await call(t.app, 'POST', '/v1/notes', {
        token: user.token,
        body: { title: 'Roadmap', bodyMd: 'v1' },
      })
    ).json.note;
    expect(note.version).toBe(1);

    // 3. First update wins → head moves to version 2.
    const ok = await call(t.app, 'PATCH', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { bodyMd: 'v2', baseVersion: 1 },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.note.version).toBe(2);

    // 4. A second update still claiming baseVersion 1 is a conflict.
    const stale = await call(t.app, 'PATCH', `/v1/notes/${note.id}`, {
      token: user.token,
      body: { bodyMd: 'v2-prime', baseVersion: 1 },
    });
    expect(stale.status).toBe(409);
    // Error envelope is { error: { code, message, conflict? } } (app.ts:72).
    expect(stale.json.error.conflict.note.version).toBe(2);
  });
});
```

3. Assert on the **wire shape**, not internal rows: `res.status` for the HTTP code and `res.json.<field>` for the response envelope. Success bodies are the serialized types (`{ note }`, `{ notes }`, `{ activity }`, `{ token, agentToken }`); failures are `{ error: { code, message, conflict? } }`.

4. Need an agent actor? Mint a scoped token through the API, exactly as the product does:

```ts
const issued = await call(t.app, 'POST', '/v1/agents/tokens', {
  token: user.token,               // token issuance is a *user* action
  body: { agentName: 'Researcher', scopes: ['notes:read', 'notes:write'] },
});
const agentToken = issued.json.token;             // begins 'iris_at_'
// issued.json.agentToken.id is the row id, e.g. for DELETE /v1/agents/tokens/:id
```

Then pass `token: agentToken` to `call()` to act as the agent. See `agent-undo.test.ts:28-51` for the full attributable-write-then-undo flow, and `tenant-isolation.test.ts` for the two-tenant setup (`signUp` twice → `alice` / `bob`).

5. Run it:

```bash
pnpm --filter @iris/api test              # from repo root
# or, inside apps/api:
pnpm test                                 # → vitest run
pnpm test:watch                           # → vitest (watch)
pnpm vitest run test/<feature>.test.ts    # single file
```

No DB to start, no `DATABASE_URL` to set — the vitest env forces the in-memory path.

## Invariants & gotchas

- **One DB per file, shared by every `it()`.** State written in one case is visible to the next. Don't rely on ordering; get a clean slate by calling `signUp()` for a fresh workspace instead of expecting an empty DB. Reusing one `user` across cases in the same describe is fine as long as you account for the accumulated rows.
- **RLS does not enforce isolation in tests.** PGlite connects as a Postgres superuser and **bypasses RLS** (`client.ts:56`). The GUC is still set so the identical code path enforces RLS on a real non-superuser cluster, but the in-repo proof of tenant isolation is the **application-layer** `where workspace_id = …` filter — which is exactly what `tenant-isolation.test.ts` asserts (Bob gets 404, not a DB error).
- **Never assume `res.json` is defined.** `call()` swallows JSON parse errors and returns `undefined` (`helpers.ts:57`). For 204s (e.g. `DELETE /v1/agents/tokens/:id`) and the zip `/v1/export` there is no JSON — assert on `res.status` and don't touch `res.json`.
- **`signUp()` throws on non-201** — a failing sign-up surfaces as a thrown error inside `beforeAll`/the test, not an assertion. If a whole file dies at setup, suspect a migration or schema change.
- **Migrations run as whole files.** New migrations go in `apps/api/migrations/*.sql` and are applied in filename order, uncut. Don't write a migration that depends on `;`-splitting; keep `DO $$…$$` blocks intact or `client.exec` will still run them but a broken statement fails the entire file → every test in every file fails at `makeApp()`.
- **Always drive through `call()` / `app.inject`, never a real listen.** No sockets, no ports, no `app.listen()` — that's why tests are fast and parallel-safe across files. `fileParallelism: false` means files are sequential anyway; within-file parallelism doesn't exist.
- **Test the route, not the service directly.** These are integration tests on purpose: hitting `/v1/...` exercises `authGuard` → `runTenant` (the one workspace-scoped transaction) → service → serialize. Calling a service function in isolation skips the tenant boundary and the auth/scope checks, which is usually the thing you actually want to prove.
- **Scopes and users:** user tokens implicitly hold every scope; agent tokens hold only what they were issued. `requireScope` (`context.ts:18`) throws 403; `requireUser` gates issuance/undo/devices/checkout to real users (agents get 403). Assert 403 for scope violations, 401 for a revoked/invalid token (see `agent-undo.test.ts:108-133`).
- **Env is fixed by config, not your shell.** If a test unexpectedly reaches a real service, something set `DATABASE_URL`/`STRIPE_SECRET_KEY` outside vitest, or a new code path read `process.env` directly instead of the resolved `env` module — the harness relies on `vitest.config.ts` `env` winning.
