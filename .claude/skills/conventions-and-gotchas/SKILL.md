---
name: conventions-and-gotchas
description: Open before bumping a dependency, touching tsconfig/eslint/imports, adding an error path or serializer, or when a build/lint/typecheck breaks after an upgrade — the pinned versions and traps that already bit us.
---

## When to use

- A `pnpm typecheck`, `pnpm lint`, `tsx`, esbuild, or Metro build breaks and you suspect a version/import mismatch.
- You are about to bump `typescript`, `typescript-eslint`, `zod`, `archiver`, `expo`/`expo-*`, `react-native`, or add a new dep.
- You are adding a relative import in `packages/shared`, or an `import ... from '...'` that a bundler must resolve.
- You are throwing a new error from a route, or adding/changing a `serialize*` mapper.
- PGlite fails to open, or a fresh clone won't boot the API.
- You are hashing a secret, or wonder why we use scrypt and not argon2/bcrypt.
- `expo install <pkg>` hangs or fails behind the proxy.

These are cross-cutting rules, not one feature. Grep here first before "just upgrading."

## Mental model

Iris is a pnpm monorepo (`pnpm@10.33.0`, Node >=22) where the toolchain is deliberately **pinned and un-clever** so a fresh `git clone && pnpm i` boots with zero external services. `packages/shared` ships **raw `.ts`** (its `package.json` `main`/`types`/`exports` all point at `./src/*.ts`, no build step) so both the API (via `tsx`/esbuild) and mobile (via Metro) consume it directly — which forces a specific import discipline and version pinning. Lint is intentionally **not** type-aware and typecheck is a separate `tsc` pass, so the two are decoupled and neither is coupled to any one tsconfig. Most "gotchas" below are places where the newest version of a tool changed its API or its peer-range and would silently break one of these two bundlers. When in doubt: match the pinned version, run `pnpm typecheck` AND `pnpm lint` (they catch different things), and don't introduce a build step for `shared`.

## Key files

- `package.json` (root) — pins `typescript@5.9.3`, `typescript-eslint@8.64.0`, `eslint@10.7.0`, `prettier@3.9.5`. Scripts: `typecheck` (per-package `tsc`), `lint` (`eslint .`), `test` (api only), `dev:api`, `db:migrate`.
- `tsconfig.base.json` — `moduleResolution: "Bundler"`, `module: ESNext`, `target ES2022`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax: false`, `isolatedModules`. Every package extends this.
- `apps/api/tsconfig.json` — adds `allowImportingTsExtensions: true` + `noEmit` (api can write `.ts` in specifiers; shared cannot — see gotchas).
- `eslint.config.mjs` — flat config, `js.recommended` + `tseslint.configs.recommended` + `prettier`. **No `parserOptions.project`** (not type-aware, by design — comment at top). `no-explicit-any` off, unused-vars is a warn with `^_` ignore.
- `apps/api/package.json` — `type: module`, runs via **`tsx`** (`dev: tsx watch src/index.ts`, `start: tsx src/index.ts`). Pins `archiver@^7.0.1` (+`@types/archiver@^6.0.3`), `zod@4.4.3`, `drizzle-orm@0.45.2`, `fastify@5.10.0`, `@electric-sql/pglite@0.5.4`.
- `apps/mobile/package.json` — Expo SDK 57 line hand-pinned: `expo@^57.0.0`, `expo-*@~57.x`, `react@19.2.7`, `react-native@0.86.0`. No build tooling beyond Expo.
- `packages/shared/package.json` — `main/types/exports` → `./src/index.ts` (raw TS). `zod@4.4.3`.
- `packages/shared/src/index.ts` / `api-client.ts` / `schemas.ts` — **extensionless** relative imports (`from './schemas'`). `schemas.ts:150` uses `z.email()` (zod v4 top-level API).
- `apps/api/src/lib/errors.ts` — `HttpError` + the `badRequest/unauthorized/forbidden/notFound/paymentRequired/conflict` constructors. The only error type routes should throw.
- `apps/api/src/app.ts:72-86` — the single `setErrorHandler` that turns `HttpError`/`ZodError`/anything into the `{ error: { code, message, conflict? } }` envelope.
- `apps/api/src/serialize.ts` — row → wire mappers; the one place `Date → ISO` and secret-stripping happens.
- `apps/api/src/lib/hash.ts` — scrypt hashing (`scrypt$salt$hash`), constant-time verify.
- `apps/api/src/db/client.ts:40`, `index.ts:18-20`, `db/migrate.ts:48-50` — PGlite open sites (mkdir-before-open).

## Playbook

### Add a new error case + return it as JSON (the most common "conventions" task)

1. **Reuse a constructor if one fits** (`apps/api/src/lib/errors.ts`). Throw from the service or route — never build a reply object by hand:
   ```ts
   import { notFound, conflict } from '../lib/errors';
   if (!row) throw notFound('Note not found');
   // version mismatch on sync: carry the authoritative server note so the client reconciles
   if (row.version !== base) throw conflict('Version conflict', serializeNote(row));
   ```
2. **Need a new code?** Add a named factory next to the others rather than `new HttpError(...)` inline, so codes stay greppable:
   ```ts
   export const tooManyRequests = (msg = 'Rate limit exceeded') =>
     new HttpError(429, 'rate_limited', msg);
   ```
3. **Do nothing in the route to shape the response.** `app.ts:72` already maps any thrown `HttpError` to `reply.status(err.status).send({ error: { code, message, conflict } })`. `ZodError` (from a schema `.parse`) auto-maps to `400 validation_error`. Unhandled errors become `500 internal_error` (message suppressed when `NODE_ENV==='production'`).
4. **If the error carries a row**, serialize it first (`conflict(msg, serializeNote(row))`) — `HttpError.conflict` is typed `Note` (wire type), never a raw `NoteRow`.
5. Verify: `pnpm typecheck` then hit the route; the body must be exactly `{"error":{"code":"...","message":"..."}}`.

### Add a serializer for a new table

1. Add `serializeX(r: XRow): X` in `serialize.ts`. Convert every `Date` with `.toISOString()` (or the `iso()` helper for nullable columns). **Never** copy a `*Hash`/`secret` column into the wire object — compare against `serializeAgentToken` (returns `scopes`, `lastUsedAt`, but no token hash).
2. The `XRow` type comes from `./db/schema`; the `X` wire type comes from `@iris/shared`. If they drift, fix `shared` (the contract), not the mapper.

## Invariants & gotchas

- **TypeScript is pinned at `5.9.3` everywhere** (root + all packages). Do not bump it: `typescript-eslint@8.64.0`'s supported-TS range is capped below **6.1**, so a newer `tsc` triggers the "unsupported TypeScript version" warning and unverified parser behavior. Bump `typescript` and `typescript-eslint` **together**, never TS alone.
- **ESLint is not type-aware — keep it that way.** `eslint.config.mjs` intentionally omits `parserOptions.project` (see the header comment) to stay fast and decoupled from any tsconfig/TS version. Type safety is a **separate** `pnpm typecheck`. Corollary: `pnpm lint` will NOT catch type errors — always run both before calling something green.
- **`packages/shared` uses extensionless relative imports** (`from './schemas'`, never `from './schemas.ts'` or `.js`). It ships raw `.ts` consumed by two different bundlers (esbuild via `tsx`, and Metro); an explicit extension breaks one of them. `apps/api` sets `allowImportingTsExtensions` so `.ts` specifiers *there* are legal — do not assume that applies to `shared`.
- **Never add a build step / `dist` to `shared`.** Consumers import `./src/*.ts` directly (per its `package.json` `exports`). A compiled output would desync from source and defeat the point.
- **zod is v4 (`4.4.3`) — use the v4 API.** Email is the top-level `z.email()` (see `schemas.ts:150`), NOT the v3 `z.string().email()`. If you copy a v3 snippet it will typecheck oddly or throw at runtime. `shared` and `api` must stay on the same zod version (schemas cross the package boundary).
- **`archiver` is pinned at v7 (`^7.0.1`).** We call it as a function: `archiver('zip', { zlib: { level: 9 } })` (`app.ts:291`). **v8 is a breaking ESM class API** — do not upgrade without rewriting the export route. Note the deliberate mismatch: runtime `archiver@7`, `@types/archiver@^6` (the v7 types live under the v6 line); that pairing is correct, don't "fix" it.
- **PGlite persists to a directory — `mkdirSync(path, { recursive: true })` BEFORE `new PGlite(path)`.** Both boot paths do this (`index.ts:18-20`, `db/migrate.ts:48-50`). Default path is `env.pglitePath` = `.data/iris`. Skip the mkdir and PGlite throws on open. Tests instead pass `new PGlite(undefined)` for a fresh **in-memory** DB (`client.ts:40`) — no dir needed. Also note: PGlite connects as superuser and **bypasses RLS**, so tenant isolation in-sandbox is proven by the application-level `workspaceId` filter, not the GUC (`client.ts:56`).
- **Secrets are hashed with Node `scrypt`, not argon2/bcrypt** (`lib/hash.ts`) — deliberately, to avoid a native build step so the whole thing runs anywhere. Stored format is the self-describing `scrypt$<saltHex>$<hashHex>`; verify with the constant-time `verifySecret` (uses `timingSafeEqual`). Don't hand-roll comparisons and don't introduce a native hashing lib.
- **The API runs through `tsx`, never `node dist/`.** There is no compile-to-JS step for the api; `tsc --noEmit` only typechecks. If you add a dep that needs a loader or CJS interop, it must work under `tsx`/esbuild.
- **Mobile Expo/RN versions are hand-pinned to the SDK 57 line** because `expo install` (which normally picks compatible versions) **cannot reach the proxy** in this environment. To add or bump an `expo-*` package, look up the version that matches Expo SDK 57 and pin it by hand (match the `~57.x` / exact-version style already in `apps/mobile/package.json`) rather than running `expo install`.
- **The error envelope is fixed: `{ error: { code, message, conflict? } }`.** It is produced in exactly one place (`app.ts:72`). Routes throw `HttpError`; they must not build ad-hoc `reply.send({ error: ... })`. Changing the envelope shape breaks the shared typed client.
- **`serialize.ts` is the only Date→ISO and secret-stripping boundary.** Wire types use ISO strings; rows use `Date`. Don't send a `*Row` straight to `reply.send` and don't add a second place that stringifies dates.
