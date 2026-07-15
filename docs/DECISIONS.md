# Iris — Architecture Decisions

This is an append-only log of the load-bearing choices made while building the
foundation. Each entry states the decision, the alternatives weighed, and *why* — so a
future engineer can tell whether a new requirement should change the answer.

Status legend: **Accepted** (in force), **Superseded**, **Proposed**.

---

## ADR-000 — Monorepo, one TypeScript codebase

**Accepted.**

One pnpm workspace holds everything: `apps/api` (backend), `apps/mobile` (Expo client
for iOS/Android/web), and `packages/shared` (zod schemas + typed API client used by
both). One language (TypeScript) end to end so request/response types are *shared, not
duplicated* — the client imports the exact schema the server validates against.

- **pnpm** workspaces with `node-linker=hoisted` (Metro + pnpm symlinks are still
  fussy; a hoisted layout avoids the known bundler resolution failures).
- The three pillars each cut across client and server; a monorepo keeps a pillar's
  change in one PR instead of two synchronized ones.

---

## ADR-001 — Backend language & framework: TypeScript + Fastify

**Accepted.** The brief allowed Node/Fastify, Hono, or Python/FastAPI — "pick one,
justify it, don't split."

**Chosen: Fastify (Node, TypeScript).**

- **Type sharing beats everything else here.** The single biggest source of bugs in a
  notes+sync product is client/server payload drift. With TS on both ends, `packages/shared`
  is imported by client and server; a schema change is a compile error on the other side,
  not a runtime surprise on a user's phone.
- **Fastify over Hono:** Fastify's mature plugin ecosystem (auth, cors, rate-limit,
  schema validation, lifecycle hooks) is exactly the "boring, correct plumbing" this
  foundation wants. Hono is leaner and edge-friendly, but we deploy a single long-lived
  Node service to Fly/Railway/Render — Fastify's node-first design fits that deploy target.
- **Fastify over FastAPI (Python):** FastAPI is excellent, but choosing it forfeits the
  shared-types win and splits the language surface the solo team has to maintain. Not worth it.

**Runtime choices that keep it boring:** `tsx` to run/watch TS directly (no build step in
dev), `vitest` for tests (esbuild transpile — fast, version-agnostic), `pino` for logs.

---

## ADR-002 — Database: Postgres, with PGlite for local/dev/test

**Accepted.**

Postgres is the **system of record** — the brief mandates row-level tenant isolation
from the first migration, and Postgres RLS is the strongest primitive for that.

**Driver strategy (two backends, one schema):**

| Environment | Driver | Why |
| --- | --- | --- |
| production | `drizzle-orm/node-postgres` → managed Postgres | real cluster, connection pool |
| dev / test / CI | `drizzle-orm/pglite` → [PGlite](https://pglite.dev) | Postgres compiled to WASM, **in-process, zero infra** |

PGlite runs the *actual Postgres engine* (same source, WASM build) including RLS,
triggers, and transactions — so our tenant-isolation tests exercise real Postgres
semantics without a running server, a Docker daemon, or CI service containers. The
selection is automatic: `DATABASE_URL` present → node-postgres; absent → PGlite at
`.data/iris.db`. Migrations are the same SQL against both.

**ORM: Drizzle.** Type-safe schema-as-code, SQL-first migrations we can read in review,
first-class support for both the node-postgres and pglite drivers. Chosen over Prisma
(heavier engine, weaker raw-SQL/RLS ergonomics) and over hand-rolled SQL (no type safety).

---

## ADR-003 — Tenant isolation: `workspace_id` on every row + Postgres RLS

**Accepted.** This is pillar-load-bearing and the hardest thing to retrofit, so it is in
from migration 0001.

Two layers of defense:

1. **Application layer.** Every tenant-owned table carries a non-null `workspace_id`.
   All data access goes through repository functions that take a `workspaceId` and filter
   by it; there is no query path that omits it. The authenticated principal (user session
   *or* agent token) resolves to exactly one `workspace_id`, set per request.
2. **Database layer (defense in depth).** RLS policies on tenant tables gate every row by
   a `current_setting('iris.workspace_id')` GUC that the request sets inside its
   transaction. Even a buggy query that forgets the `WHERE` clause returns nothing across
   the tenant boundary.

A test (`tenant-isolation.test.ts`) proves workspace A's principal cannot read workspace
B's notes through the API. That test is the definition of this ADR being true.

---

## ADR-004 — Auth: provider seam, local provider shipped; managed provider is the prod target

**Accepted — with a flagged deviation. Read this one carefully.**

The brief says: use a managed provider (Clerk or Supabase Auth) "so you're not building
password reset and OAuth from scratch."

**What we built:** an `AuthProvider` interface (`verifyCredentials`, `createUser`,
`getPrincipal`) with a **`LocalAuthProvider`** implementation (email + password hashed
with Node's built-in `crypto.scrypt`, sessions via signed JWT using `jose`). It is the
default and makes the entire foundation **runnable and testable offline, with zero
external accounts or native build dependencies.**

**Why we deviated from "managed provider now":** the Definition of Done requires that we
*actually ran* the sign-up → note → sync → agent-undo flow — "'should work' is not
'works.'" Wiring Clerk/Supabase as the only auth path would make that flow un-runnable in
this environment (no tenant keys, no hosted callback). So we shipped a working local
provider *behind a seam* and left the managed provider as a drop-in.

**The seam is the point.** `AuthProvider` is small and provider-shaped on purpose: a
`ClerkAuthProvider` / `SupabaseAuthProvider` implements the same three methods and is
selected by env. Password reset, OAuth, and email verification are **explicitly the
managed provider's job** — we did not build them into `LocalAuthProvider` beyond what a
foundation needs (it is not hardened for production as-is; see ROADMAP).

**If you are taking this to production:** implement the managed provider against the
interface, flip `AUTH_PROVIDER=clerk|supabase`, and delete nothing — the local provider
stays for tests and offline dev.

---

## ADR-005 — Sync engine: Legend-State (client) + custom Postgres change-feed (server)

**Accepted.** This is the ADR the brief asked for by name (the "short spike").

### Requirement

Offline-first; per-user/per-workspace partitioned sync; works in **React Native *and*
web**; "conflicts are detected and surfaced, never silently dropped"; and — critically —
must not force extra backend infrastructure, because ADR-006 commits us to *single
service, single Postgres, one-command deploy.*

### Candidates evaluated

| Engine | Offline-first | RN + Web | Extra infra required | Verdict |
| --- | --- | --- | --- | --- |
| **Legend-State** | yes (observable + persistence plugins) | yes (MMKV/AsyncStorage on RN, IndexedDB on web) | **none** — sync transport is ours | **Chosen** |
| WatermelonDB | yes (SQLite) | RN strong; web via LokiJS is weaker | none (custom sync endpoints) | Runner-up |
| PowerSync | yes | yes | **yes** — hosted/sidecar sync service + Postgres replication | Rejected for foundation |
| ElectricSQL | yes | yes | **yes** — Electric sync service in front of Postgres | Rejected for foundation |

### Decision & rationale

**Client: Legend-State** as the local-first layer — a fine-grained observable store with
pluggable offline persistence (react-native-mmkv on device, IndexedDB on web). Local
edits mutate the observable synchronously, so the editor never waits on the network.
Legend-State's persistence + retry primitives give us the "instant, offline, reconciles
later" behavior without us reimplementing an observable/persistence engine.

**Server: a custom change-feed** — the sync *transport* is a small, boring REST protocol
we own:

- `GET /v1/sync/changes?since=<cursor>` — pull rows changed since a monotonic cursor
  (`updated_at` + id tiebreak), workspace-scoped.
- `POST /v1/sync/push` — push a batch of local mutations. **Each mutation carries the
  `base_version` it was derived from.** If the server's current version differs, the push
  is **rejected as a conflict (HTTP 409)** and the response includes the authoritative
  server row. The client surfaces the conflict — it never silently overwrites.

**Why not adopt a heavier engine.** PowerSync and ElectricSQL are excellent, but both
introduce a *second piece of infrastructure* (a sync service, and in Electric's case
Postgres logical replication). That directly violates ADR-006's "no extra infra."
WatermelonDB is the closest runner-up and would also work, but its web target (LokiJS)
is the weakest of its adapters and it couples the client to a mirrored SQLite schema; for
a Markdown-note domain the observable model is a better fit and lighter to reason about.

**Are we "hand-rolling CRDTs"?** No — and this is deliberate. Our notes are
whole-document Markdown, and our conflict policy is **version-based optimistic
concurrency with surfacing**: last writer must have seen the current version, or the
write is rejected and shown to the user. This is exactly the "detect and surface, never
silently drop" the brief demands, without the complexity/opacity of CRDT merge for a
single-operator product. If real-time multi-human co-editing ever becomes a goal (it is a
stated non-goal), *that* is when a CRDT text type earns its keep — noted in ROADMAP.

**Version note.** We pin Legend-State at **v2 stable** and use only its core primitives
(`observable`, `observe`) for reactive local state, binding to React through
`useSyncExternalStore` rather than any version-specific React hooks. We own the sync loop
and persistence (talking to our own REST change-feed), so the client's coupling to
Legend-State is deliberately thin — upgrading to v3 (whose richer `synced`/`syncedCrud`
API is still stabilizing) is a low-risk, isolated change when it lands.

---

## ADR-006 — Deployment: single service, single Postgres, one command

**Accepted.** No microservices, no Kubernetes, no queue, no second datastore. The API is
one Fastify process; state lives in one Postgres. Target platforms: Fly.io / Railway /
Render. This constraint is *upstream* of ADR-005 (it is why we rejected PowerSync/Electric).

---

## ADR-007 — Billing: Stripe subscriptions, gate on multi-device sync

**Accepted.**

Mirror Obsidian's model: **local use is free; sync is the paid line.** One plan (~$5/mo)
and a free tier. The gate is enforced server-side in the sync endpoints: a free workspace
may register **one** sync device; a second device's sync is refused (`402`) unless the
workspace has an active subscription.

Stripe plumbing (Checkout session creation, customer/subscription mapping, webhook →
subscription state machine) is built and unit-tested with an injected fake Stripe client,
so the *gate logic* is proven without live keys. Live test-mode requires
`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`; see `.env.example` and ROADMAP.

---

## ADR-008 — Note storage & versioning: Markdown body + append-only version history

**Accepted.**

A note's canonical content is a **Markdown string** (`body_md`) plus light metadata
(title, folder). **Folders** (not tags) are the organizational primitive for the
foundation — one is enough; the other is a documented follow-up.

**Every save writes a `note_versions` row** (immutable snapshot: body, title, author
principal, timestamp, monotonically increasing `version`). The live `notes` row is a
denormalized pointer to the current state for fast reads. This makes versioning
*load-bearing for pillar #2* (reversibility) rather than a feature to add later:

- Restore = write the old snapshot's content as a new version (history is never rewritten).
- Undo of an agent action = restore the version that preceded it, logged as a compensating
  entry in the activity log.

---

## ADR-009 — Agent actors: hashed scoped tokens + append-only activity log

**Accepted.** The moat (pillar #2).

- **Agent** = a principal row belonging to a workspace, with a display name.
- **Token** = issued once, returned in plaintext exactly once, stored only as a scrypt
  hash. Carries **scopes** (`notes:read`, `notes:write`) and is **revocable** (soft
  delete + revoked_at). Presented as `Authorization: Bearer <token>`.
- **Every write** (by a user *or* an agent) appends to `activity_log` (actor type + id,
  action, target note, resulting version, timestamp). The log is **append-only** — undo
  does not delete history, it appends a compensating action.
- The **activity feed** screen reads this log; **undo** restores the pre-action version.

Rate limits are per-token (a coarse fixed-window limiter in the foundation; documented as
a place to harden).

---

## Summary: the shape these decisions produce

One TypeScript monorepo → one Fastify service → one Postgres (PGlite locally). Auth,
notes+versions, agent tokens, activity log, sync change-feed, billing, and export are all
routes on that one service, all workspace-scoped, all sharing types with a Legend-State
local-first Expo client that runs on iOS, Android, and web. Boring on purpose.
