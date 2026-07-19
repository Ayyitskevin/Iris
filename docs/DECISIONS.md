# Iris — Architecture Decisions

This is an append-only log of the load-bearing choices made while building the
foundation. Each entry states the decision, the alternatives weighed, and _why_ — so a
future engineer can tell whether a new requirement should change the answer.

Status legend: **Accepted** (in force), **Superseded**, **Proposed**.

---

## ADR-000 — Monorepo, one TypeScript codebase

**Accepted.**

One pnpm workspace holds everything: `apps/api` (backend), `apps/mobile` (Expo client
for iOS/Android/web), and `packages/shared` (zod schemas + typed API client used by
both). One language (TypeScript) end to end so request/response types are _shared, not
duplicated_ — the client imports the exact schema the server validates against.

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

| Environment     | Driver                                              | Why                                                   |
| --------------- | --------------------------------------------------- | ----------------------------------------------------- |
| production      | `drizzle-orm/node-postgres` → managed Postgres      | real cluster, connection pool                         |
| dev / test / CI | `drizzle-orm/pglite` → [PGlite](https://pglite.dev) | Postgres compiled to WASM, **in-process, zero infra** |

PGlite runs the _actual Postgres engine_ (same source, WASM build) including RLS,
triggers, and transactions — so our tenant-isolation tests exercise real Postgres
semantics without a running server, a Docker daemon, or CI service containers. The
selection is automatic: `DATABASE_URL` present → node-postgres; absent → PGlite at
the `.data/iris` directory. Migrations are the same SQL against both.

**ORM: Drizzle.** Type-safe schema-as-code, SQL-first migrations we can read in review,
first-class support for both the node-postgres and pglite drivers. Chosen over Prisma
(heavier engine, weaker raw-SQL/RLS ergonomics) and over hand-rolled SQL (no type safety).

---

## ADR-003 — Tenant isolation: `workspace_id` on every row + Postgres RLS

**Accepted.** This is pillar-load-bearing and the hardest thing to retrofit, so it is in
from migration 0001.

Two layers of defense:

1. **Application layer.** Every workspace-owned child table carries a non-null
   `workspace_id`; `workspaces` is the tenant root rather than its own child.
   All data access goes through repository functions that take a `workspaceId` and filter
   by it; there is no query path that omits it. The authenticated principal (user session
   _or_ agent token) resolves to exactly one `workspace_id`, set per request.
2. **Database layer (defense in depth).** RLS policies on workspace-owned child tables
   gate every row by
   a `current_setting('app.current_workspace')` GUC that the request sets inside its
   transaction. Even a buggy query that forgets the `WHERE` clause returns nothing across
   the tenant boundary.

The `workspaces` root and the pre-tenant auth-bootstrap tables (`users`,
`agent_tokens`) are outside the `workspace_isolation` policy. Their reads remain
explicitly id-/workspace-scoped at the application layer.

A test (`tenant-isolation.test.ts`) proves workspace A's principal cannot read workspace
B's notes through the API. That test is the definition of this ADR being true.

---

## ADR-004 — Auth: provider seam, local provider shipped; managed provider is the prod target

**Accepted — with a flagged deviation. Read this one carefully.**

The brief says: use a managed provider (Clerk or Supabase Auth) "so you're not building
password reset and OAuth from scratch."

**What we built:** an `AuthProvider` interface (`signUp`, `signIn` — where `signUp` is
also the tenant-provisioning path) with a **`localAuthProvider`** implementation (email + password hashed
with Node's built-in `crypto.scrypt`, sessions via signed JWT using `jose`). It is the
default and makes the entire foundation **runnable and testable offline, with zero
external accounts or native build dependencies.**

**Why we deviated from "managed provider now":** the Definition of Done requires that we
_actually ran_ the sign-up → note → sync → agent-undo flow — "'should work' is not
'works.'" Wiring Clerk/Supabase as the only auth path would make that flow un-runnable in
this environment (no tenant keys, no hosted callback). So we shipped a working local
provider _behind a seam_ and left the managed provider as a drop-in.

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

Offline-first; per-user/per-workspace partitioned sync; works in **React Native _and_
web**; "conflicts are detected and surfaced, never silently dropped"; and — critically —
must not force extra backend infrastructure, because ADR-006 commits us to _single
service, single Postgres, one-command deploy._

### Candidates evaluated

| Engine           | Offline-first                           | RN + Web                                   | Extra infra required                                         | Verdict                 |
| ---------------- | --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ | ----------------------- |
| **Legend-State** | yes (observable; Iris-owned repository) | yes (Iris-owned SQLite/IndexedDB adapters) | **none** — sync transport is ours                            | **Chosen**              |
| WatermelonDB     | yes (SQLite)                            | RN strong; web via LokiJS is weaker        | none (custom sync endpoints)                                 | Runner-up               |
| PowerSync        | yes                                     | yes                                        | **yes** — hosted/sidecar sync service + Postgres replication | Rejected for foundation |
| ElectricSQL      | yes                                     | yes                                        | **yes** — Electric sync service in front of Postgres         | Rejected for foundation |

### Decision & rationale

**Client: Legend-State** as the local-first observable layer. Local edits mutate the
observable synchronously, so the editor never waits on the network. The foundation
currently persists owner replicas through a small SecureStore/localStorage adapter;
transactional SQLite on native and IndexedDB on web are required before release (ADR-011
and ROADMAP). Legend-State remains independent of that repository choice.

**Server: a custom change-feed** — the sync _transport_ is a small, boring REST protocol
we own:

- `GET /v1/sync/changes?since=<cursor>` — pull rows changed since a monotonic cursor
  (`updated_at` + id tiebreak), workspace-scoped.
- `POST /v1/sync/push` — push a batch of local mutations. **Each mutation carries the
  `base_version` it was derived from.** If the server's current version differs, the push
  is **rejected as a conflict (HTTP 409)** and the response includes the authoritative
  server row. The client surfaces the conflict — it never silently overwrites.

**Transport supersession note.** ADR-012 supersedes the timestamp-cursor and
endpoint-level conflict details above with the integrated Phase 2.2a transport. ADR-005's
engine selection, ownership model, and conflict-surfacing rationale remain in force.

**Why not adopt a heavier engine.** PowerSync and ElectricSQL are excellent, but both
introduce a _second piece of infrastructure_ (a sync service, and in Electric's case
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
stated non-goal), _that_ is when a CRDT text type earns its keep — noted in ROADMAP.

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
Render. This constraint is _upstream_ of ADR-005 (it is why we rejected PowerSync/Electric).

---

## ADR-007 — Billing: Stripe subscriptions, gate on multi-device sync

**Accepted.**

Mirror Obsidian's model: **local use is free; sync is the paid line.** One plan (~$5/mo)
and a free tier. The billing gate is enforced when a signed-in user explicitly
registers a device: a free workspace may register **one** sync device; a second
registration is refused (`402`) unless the workspace has an active subscription. Push
and pull accept only an already-registered workspace-composite device id; an unknown id
is `403` and sync never allocates a plan slot implicitly.

Stripe plumbing (Checkout session creation, customer/subscription mapping, webhook →
subscription state machine) is built and unit-tested with an injected fake Stripe client,
so the _gate logic_ is proven without live keys. Live test-mode requires
`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`; see `.env.example` and ROADMAP.

---

## ADR-008 — Note storage & versioning: Markdown body + append-only version history

**Accepted.**

A note's canonical content is a **Markdown string** (`body_md`) plus light metadata
(title, folder). **Folders** (not tags) are the organizational primitive for the
foundation — one is enough; the other is a documented follow-up.

**Every save writes a `note_versions` row** (immutable snapshot: body, title, folder,
tags, author principal, timestamp, monotonically increasing `version`). Migration `0004`
adds explicit folder-snapshot knownness so a historical SQL `NULL` (the real root folder)
cannot be confused with a legacy snapshot that never captured folder at all (ADR-013).
The live `notes` row is a denormalized pointer to the current state for fast reads. This
makes versioning _load-bearing for pillar #2_ (reversibility) rather than a feature to
add later:

- Restore = write the recorded snapshot fields as a new version (history is never rewritten).
- Undo of an agent action = restore the pre-action content and organization fields only
  while that action is still the note's head, logged as a compensating entry in the
  activity log. A later committed action makes whole-snapshot undo conflict instead of
  erasing the newer work.
- A direct restore includes the rendered head version as `baseVersion`; a stale history
  choice conflicts instead of overwriting a newer committed head.

ADR-014 extends these snapshots with explicit live/deleted state, and ADR-015 makes a
sync revival an explicit, attributable restore intent instead of an ordinary edit.

---

## ADR-009 — Agent actors: hashed scoped tokens + append-only activity log

**Accepted.** The moat (pillar #2).

- **Agent** = a principal row belonging to a workspace, with a display name.
- **Token** = issued once, returned in plaintext exactly once, stored only as a scrypt
  hash. Carries **scopes** (`notes:read`, `notes:write`) and is **revocable** (soft
  delete + revoked_at). Presented as `Authorization: Bearer <token>`.
- **Every note write** (by a user _or_ an agent) appends to `activity_log` (actor type +
  id, action, target note, resulting version, timestamp). The log is **append-only** —
  undo does not delete history, it appends a compensating action.
- The **activity feed** screen reads this log; **undo** restores title, body, folder, and
  tags as a new head version only when the target action remains current. A legacy
  snapshot with unknown folder state preserves the current folder and returns that
  partial result explicitly; missing required history and stale target actions fail
  loud. ADR-014/015 make deletion and explicit sync resurrection reversible too.

Agent-token rate limiting is not implemented yet; it remains an explicit ROADMAP item.

---

## ADR-010 — Tags & full-text search (phase 2)

**Accepted.**

**Tags** are a `jsonb` string array on `notes` and on every new `note_versions` snapshot.
They are versioned and both direct restore and activity undo carry them forward alongside
folders (ADR-013). Chosen over a normalized `note_tags` join table because tags then
travel with the note through sync (part of the note payload), export (frontmatter), and
history — with no joins. Membership filtering uses the
jsonb `?` operator, backed by a GIN index; the tag list is aggregated (small workspaces).
Tags are normalized (trim / lowercase / de-dupe) at the service boundary so `Work` and
`work` collapse. Folders remain the primary org primitive; tags are orthogonal and
additive (they close the ROADMAP "tags" seam).

**Search** is Postgres full-text search over a **generated, stored `tsvector` column**
(`to_tsvector('english', title || ' ' || body_md)`) with a GIN index, ranked by
`ts_rank`. It's a generated column (not computed per query) so the index does the work;
valid in a generated column because the text-search config is a constant. Workspace-scoped
and tombstone-aware like every other read. PGlite runs the exact same FTS, so it's fully
tested in-repo. The client hits `/v1/notes/search` (debounced) with a local substring
fallback when offline — search stays useful without the network, in keeping with pillar #1.

Both features are pure additions on the existing spine: a migration (`0002`), tags carried
through the same `recordVersionAndActivity` choke point, and two new read routes
(`/v1/notes/search`, `/v1/tags`) plus a `?tag=` filter on the notes list.

---

## ADR-011 — Lossless reconciliation behind owner-bound session leases

**Accepted and integrated.**

The first client loop takes an outbox snapshot, awaits the network, and then clears the
current outbox. An edit created during that await can therefore be erased by an older
acknowledgement. Its single conflict marker also cannot retain both sides of multiple
independent conflicts.

`apps/mobile/src/sync/reconcile.ts` is a side-effect-free contract for the replacement:

- only an acknowledged `opId` is removed;
- a newer operation for the same note is preserved and rebased;
- each conflict retains the newest local mutation and server head independently; and
- every pull page is drained, with a fail-loud guard for a stalled cursor.

Runtime integration is permitted only behind the accompanying ownership fence:

- credentials are persisted separately from replicas;
- every replica is keyed by immutable workspace + user identity;
- legacy `iris:state:v1` migration preserves attributable known-owner drafts plus a
  token-free recovery copy,
  while quarantining mixed or ownerless data and replacing the global cursor/device
  identity with fresh owner-scoped values;
- each sync cycle captures one immutable token, owner, device, and generation;
- account transition aborts the old generation, and every network await is checked before
  its response can mutate state;
- voluntary sign-out commits a same-key, token-free tombstone before the UI reports
  signed-out; a current 401 fences the UI immediately, then commits the same tombstone,
  with temporary total storage failure surfaced distinctly and retried by the root loop;
- current 401, billing gate, network failure, and stale cancellation are distinct states;
  and
- conflict decisions include the rendered owner and operation id, so stale UI callbacks
  cannot resolve another account's draft.

The production coordinator now imports this pure contract. Focused mobile tests cover its
pure transforms plus delayed push and pull pages, sign-out, A-to-B switching, stale and
current 401s, cursor isolation, cross-workspace response rejection, A-outbox/B-token
separation, verified/quarantined recovery copies, storage failpoints, save ordering, and
stale conflict decisions.

All raw owner-replica access now crosses an `OwnerReplicaRepository` contract. Its current
key/value adapter validates the embedded immutable owner, serializes replacement commits
per owner, and verifies the exact bytes after every write. Active local note and outbox
changes publish through one lease-fenced root reducer; optimistic edits expose their
durability promise, while sync, conflict, restore, and undo commits retain
rollback-if-unchanged behavior. This is the repository seam, not the release storage
implementation: replica-v2 bytes and keys remain unchanged, and the adapter still stores
one size-limited SecureStore/localStorage value.

The durable transport half of Sync v2 is integrated in ADR-012. Before release, the
note-specific wire shape must become a generic resource envelope so projects and tasks
do not require a second sync engine. Native resources and the outbox must move from the
size-limited per-owner SecureStore value into transactional SQLite while credentials
remain in the OS keystore; web replicas need IndexedDB plus cross-tab session
coordination, and quarantined legacy `iris:state:v1` recovery needs an explicit user
import path.

---

## ADR-012 — Commit-serialized cursors and request-bound sync receipts

**Accepted and integrated as Phase 2.2a's durable transport half.** This ADR does not
mean the whole of Sync v2 is complete or that Iris is release-ready.

A PostgreSQL sequence can be allocated by transaction A before transaction B, while B
commits first. Advancing a client cursor through B would then skip A when it eventually
commits. Wall-clock timestamps have the same late-commit failure and can also move
backward.

Phase 2.2a serializes note writers per workspace before they acquire note-row locks. A
statement trigger locks one `workspace_sync_cursors` row; a row trigger increments that
counter for each changed note. The resulting `sync_seq` values therefore follow commit
serialization, and the API exposes only opaque
`v2:<workspace-id>:<sequence>` cursors. A cursor bound to another workspace is rejected.
Migration 0003 deterministically backfills existing notes; a recognized legacy timestamp
cursor or short-lived unbound draft v2 cursor receives one safe full replay and a bound
cursor. Malformed/ahead cursors are rejected, and the migration transactionally
suspends then restores FORCE RLS for a non-`BYPASSRLS` backfill. Every existing-note
update path uses CAS: the workspace lock orders commits, but cannot protect a read that
happened before the write statement acquired it.

The runner owns a checksummed migration ledger. It recognizes only frozen legacy 0001
or 0001+0002 safety-critical structural signatures—including exact RLS policies, column
shapes, critical indexes, and foundation constraints—records that baseline, and then
applies each pending SQL file plus receipt atomically. It also verifies the current-head
additive safety-critical artifacts for every applied migration against their receipts on
later runs: migration `0003` remains checked after `0004` adds version-organization
columns and defaults. A receipt alone is not accepted as proof. Partial or drifted
signatures, checksum drift, history gaps, unknown receipts, and unledgered or mismatched
artifacts fail loud. Real Postgres runs are serialized by one same-session advisory lock.

CI provisions a dedicated PostgreSQL 16 service and runs the independent-connection
concurrency gate for commit-ordered note sequences and serialized free-plan device
claims. GitHub Actions run `29506816638` passed that gate for exact commit
`8a8785114623d3e601f26ddf7b6eed21b23415cf`.

Client-chosen note and device ids now identify rows only together with their workspace;
the same local id can therefore exist safely in two workspaces. A signed-in user must
explicitly register a device through `POST /v1/devices` before it can sync. Push and pull
accept only that existing workspace-composite device identity and never allocate
billable device state for an agent implicitly.

`sync_idempotency` permanently keys each `opId` by workspace and binds it to the
authenticated actor, device, and a SHA-256 fingerprint of the parsed payload. A
`receipt_version` freezes both that fingerprint algorithm and the stored-outcome
parser; unknown versions fail closed before note mutation. The applied-or-conflict
outcome is written in the same tenant transaction as note history and activity. An
exact retry replays that validated outcome without another resource mutation,
history/activity entry, receipt, or logical cursor advance; any other reuse fails loud,
and a collision rolls back the full request batch. Pushes take the workspace
cursor lock before any operation receipt so reversed operation orders cannot deadlock
receipt rows against the cursor row.

Before dispatch, the mobile coordinator greedily stages and persists an exact
`pendingPush` request within both a six-operation limit and a 1,900,000-byte serialized
UTF-8 request budget. Fastify's distinct outer ingress ceiling is 2,097,152 bytes. Any
batch found pending at the start of a later cycle is first
reconfirmed through the serialized persistence queue, closing the memory-visible /
failed-save interleaving. A lost response, process restart, or failed local
acknowledgement therefore retries the same operation ids and payloads while preserving
and rebasing any newer outbox edit. The same `/v1/sync/push` ingress enforces those
finite limits for every client; there is no uncapped legacy lane. Six worst-case
currently bounded notes, including JSON escaping and result metadata, also fit the
1,900,000-byte push response budget. A migrated pre-limit oversized note remains
lossless and may occupy one conflict response beyond that modern-data budget. One sync
cycle drains at most 16 chunks (96 operations), durably
reconciling and clearing each exact pending request before it stages the next; any
larger remainder stays in the outbox for a later cycle.

New Markdown bodies are limited to 256 KiB of JSON-encoded UTF-8 string content. Pull
pages are bounded by both 50 notes and a 1 MiB serialized response budget; one
recognized pre-limit oversized note may occupy a page alone so migration remains
lossless. The client rejects cursor cycles and stops a pathological drain after 1,000
unique pages. Successful push and pull responses are validated at runtime before
reconciliation. Non-retryable protocol failures become a durable, owner-scoped sync
issue that stops all network work until the operator uses the visible manual recovery
action to rekey affected operation ids, reset a bad cursor, restage a locally invalid
request, or retry without discarding the exact pending payload.

This closes the durable transport half, but it does not make the current
SecureStore/localStorage replica transactional; the remaining Sync v2 and release
boundaries are tracked in ROADMAP.

---

## ADR-013 — Exact organizational history with explicit legacy uncertainty

**Accepted.**

Migration `0004` adds `folder` and `folder_snapshot_known` to `note_versions`. The
knownness marker defaults to `false`, so a rolling old binary that omits both fields
creates an explicitly incomplete snapshot rather than falsely recording root. During
upgrade, only a snapshot whose version is provably the live note's current version is
backfilled from `notes.folder`; older snapshots remain unknown. The migration suspends
and restores FORCE RLS transactionally for that backfill, and its exact columns,
defaults, and existing RLS policies join the migration runner's additive artifact gate.
Every new write supplies the folder explicitly and marks it known.

Version-history responses carry an authoritative `headVersion` and
`restoreProtocolVersion`. Direct restore requires that head as `baseVersion` alongside
`versionId`; it restores title, body, tags, and an exact known folder into a new head
version. A stale base receives the ordinary authoritative version conflict. A new client
can display but disables restore against any non-current protocol (including an unknown
future version), and a new server returns `428 restore_precondition_required` before
mutation when an old client omits the base. This is a fail-closed mixed-deployment
cutover, not silent compatibility. A legacy unknown folder fails closed unless the
caller explicitly chooses to preserve the current folder; the response reports
`folderRestored` so that choice cannot masquerade as an exact restore.

Activity responses similarly advertise `undoProtocolVersion`; a new client leaves undo
disabled while still showing activity from a non-current protocol. On the current
protocol, undo restores the prior title, body, tags, and exact known folder as a
compensating write only if the target action is still the note's head. A later head
returns an authoritative conflict. For legacy unknown folders it preserves the current
folder and reports the partial result; if the required prior snapshot is missing, it
records no fake success and returns `incomplete_history`. Version-list, activity-list,
restore, and undo responses are runtime validated by the shared client. A focused mobile
safety kernel tests frozen-head gating, route/request invalidation, latest-per-note undo,
and ambiguous completion classification. The screens distinguish load failure from an
empty list, announce errors, label legacy content-only restores, refresh the tag editor
after restore, and surface any unproven organization state.

This ADR did **not** claim full state reversibility: `note_versions` still omitted the
deleted/tombstone bit. ADR-014 closes that lifecycle-history gap without rewriting this
decision's organization contract.

---

## ADR-014 — Tri-state tombstone history and rollout-safe lifecycle restore

**Accepted.**

Migration `0005` adds nullable `note_versions.is_deleted` with deliberately no
default: `false` means captured live state, `true` means captured tombstone state, and
`NULL` means the legacy or old-binary writer never recorded lifecycle state. A default
of `false` would let a rolled-back binary fabricate known-live history. Upgrade
backfills only a version row provably equal to its note's current head; older rows stay
unknown. As in ADR-013, the migration suspends FORCE RLS only inside its transaction,
restores ENABLE + FORCE, and joins the additive artifact gate with exact type,
nullability, no-default, and policy checks.

Every current writer records `is_deleted` at the shared version/activity choke point.
The snapshot stores logical lifecycle state rather than a historical deletion timestamp:
restore and undo are new compensating writes, so recreating a tombstone receives the
new write's timestamp instead of backdating the current note.

Direct restore copies known live/deleted state into a new head. Unknown state fails
`incomplete_version_snapshot` unless the caller explicitly preserves today's state;
the response's `deletionStateRestored` prevents that partial operation from posing as
exact. Whole-snapshot undo is stricter: a missing or lifecycle-unknown prior snapshot
returns `incomplete_history` and records no note, version, or activity write. Known
state lets undo-delete revive a note and lets undo of direct or sync revival recreate
the prior tombstone. Successful undo returns the authoritative `Note` even when it is
a tombstone, so the client can fence editing immediately rather than waiting for pull.

This semantic change uses `restoreProtocolVersion = 2` and
`undoProtocolVersion = 2`. Current mutations live at
`POST /v2/notes/:id/restore` and `POST /v2/activity/:id/undo`; the corresponding v1
paths are intentionally inert and return 428. This path split is load-bearing during a
rolling deployment: an old server cannot understand a new path and returns 404, while a
new server cannot execute an old client's legacy mutation. A request field alone would
not suffice because an old Zod handler could strip it and still mutate.

The mobile client keeps non-current protocols read-only, labels live/deleted/unknown
history, explicitly preserves unknown legacy state, applies authoritative tombstone
responses immediately, blocks history mutation while the same note has local pending
work, and treats direct tombstone routes as read-only. ADR-015 closes the remaining
ordinary-sync resurrection hazard.

---

## ADR-015 — Explicit, receipt-bound sync resurrection

**Accepted.**

Sync now distinguishes `upsert`, `delete`, and `resurrect`. An ordinary upsert against
any tombstone returns the existing `version_mismatch` result with the authoritative
tombstone, even when its base version matches; the upsert path never writes lifecycle
state. `resurrect` applies only to an existing tombstone at the exact reviewed version.
A missing target fails `invalid_sync_resurrection`, while a stale tombstone or already
live head returns the ordinary authoritative conflict. Successful resurrection creates
one live version and records `note.restore`, so the actor is attributable and whole-
snapshot undo can recreate the prior tombstone.

Receipt version 1 remains deliberately unchanged. Its frozen request fingerprint already
includes the literal operation type, and its applied/conflict outcome schema does not
change. Therefore an exact resurrection retry replays its stored result, while reusing
the same operation id for upsert versus resurrect fails as an idempotency collision. No
new conflict reason is introduced solely to rename a lifecycle mismatch.

The existing `/v1/sync/push` path is rollout-safe for this additive discriminant. An old
client routed to a new server sends upsert and receives the old parseable tombstone
conflict shape. A new client routed to an old server sends the unknown `resurrect` enum
value, which the old request schema rejects before any note or receipt write; unlike an
extra object field, the operation cannot be stripped and reinterpreted as upsert.

On mobile, the retained draft becomes `resurrect` only when the operator reviews an
authoritative tombstone and chooses “Restore my draft”; “Keep deleted” accepts the
tombstone without a write. The retry type is normalized from the reviewed server state,
so a previously retained resurrection against a now-live head becomes an ordinary
upsert instead of looping. Edits collapse into an unstaged resurrection while preserving
its reviewed base. Once that exact resurrection is durably staged, newer edits remain a
separate upsert and are rebased onto the authoritative revived version after response.
This preserves both explicit lifecycle intent and post-dispatch drafts without adding a
replica or database migration.

---

## ADR-016 — Additive generic sync envelope with immutable resource-set cursors

**Accepted as a server/shared-client seam; the production mobile coordinator is not yet
cut over.**

Projects and tasks must share one owner-isolated sync engine with notes rather than grow
a parallel transport. Iris therefore adds strict `GET /v2/sync/changes` and
`POST /v2/sync/push` routes while leaving every `/v1` request, response, cursor, client
method, and service behavior unchanged. The first resource set is the literal
`notes-v1`; each resource envelope has a literal `note` type, a UUID id, and strict data.
Unknown fields, missing write fields, unknown sets, and future resource types fail before
any receipt or note write. The typed client exposes explicit `syncV2Changes` and
`syncV2Push` methods with runtime response validation and no silent route fallback.

`notes-v1` membership is immutable. Its opaque cursor is
`resource-v1:notes-v1:<workspace-id>:<sequence>` and is rejected by `/v1`; legacy
timestamp, bound-v1, and malformed/foreign/ahead cursors are rejected by `/v2`. Pull
captures the workspace counter's high-water mark, selects only notes above the caller's
sequence and at or below that mark, and advances an exhausted page to the captured high
water. This can cross sequence slots allocated by resources outside the set without
skipping them, because a future notes+projects+tasks superset must use a new set id and
start from genesis. The complete wrapped envelope—not the inner note alone—is measured
against the 50-resource/1 MiB page budget.

Generic note mutations project losslessly to the frozen receipt-v1 object
`{opId,type,note,baseVersion}` and call the existing atomic push service. Receipt version
1 is deliberate: its fingerprint already binds actor, device, operation type, every note
field, and base version, while its stored applied/conflict outcome contains the complete
authoritative note. A `/v2` operation can therefore replay through `/v1` (or the reverse)
after a lost response without another resource mutation, history/activity entry, receipt,
or logical cursor advance. The existing no-op cursor-row update still acquires the
workspace serialization lock.
Writing receipt version 2 now would make a rolled-back old binary throw on an already
committed outcome and strand the exact retry. A second resource type, another resource
set, or any behavior-bearing metadata requires receipt version 2 before its schema is
admitted.

Push still accepts at most six operations and 1,900,000 serialized bytes. The complete
generic result is checked against the same 1,900,000-byte response budget. If multiple
legacy resources would exceed it, the tenant transaction rolls back and the caller must
split the exact operations; one recognized pre-limit oversized resource remains a
lossless exception for both push and pull. Focused tests prove both cross-route replay
directions, frozen pre-generic receipt parsing, applied/conflict/lifecycle projection,
strict zero-write rejection, tenant/device/scope fences, route/set/workspace cursor
isolation, excluded-resource high-water advancement, atomic collision and response-size
rollback, bounded multi-page drains, and strict client response parsing.

This ADR adds no database table, migration, project/task model, or mobile state change.
The current coordinator remains on `/v1` until SQLite/IndexedDB repositories can persist
the resource-set id, cursor, pending envelope, resources, and outbox transactionally.
Before that cutover, request-aware reconciliation must also prove that every push result
names exactly one submitted operation and returns the expected resource/lifecycle shape;
the additive client method currently validates the standalone response schema only.
Cross-tab web ownership, recovery import, and native acceptance remain release gates.

---

## ADR-017 — Revision-fenced transactional owner-replica storage foundation

**Accepted as an unwired web storage primitive; runtime authority is unchanged.**

The persisted mobile root is already the atomic unit for notes, cursor, device identity,
outbox, exact pending request, sync issue, and conflicts. The first transactional
platform primitive therefore keeps that root opaque instead of normalizing fields into
another schema: one IndexedDB object stores `schemaVersion`, immutable `ownerKey`, a
hidden positive monotonic `revision`, and the exact serialized replica bytes. Embedded
ownership is validated both before a write and after every read.

The shared repository queues reads and commits per owner while independent owners remain
independent. A repository that has not read an existing record may not overwrite it.
IndexedDB performs get, expected-revision comparison, and replacement in one read/write
transaction and reports success only after transaction completion. The repository then
reads the durable record back and accepts only exact desired bytes, including when the
transaction committed before surfacing an error or another writer already committed the
identical bytes.

A different-byte revision conflict fences that repository instance. It does not silently
refresh its revision because optimistic edits may still be projected from the losing
root. An explicit authoritative read clears the fence; the caller must fully rehydrate
those bytes before attempting another commit. Node tests using `fake-indexeddb` cover
separate-connection races, exact bytes and revisions, owner isolation, same-owner
ordering, read/commit ordering, stale and unseen writers, idempotent conflicts,
mutate-then-throw verification, queue recovery, and corrupt owner routing.

This decision does **not** select IndexedDB in production, promote or delete a
localStorage record, coordinate browser session/network leadership, change the persisted
root to the `/v2` resource envelope, change the coordinator from `/v1`, add SQLite or
native dependencies, or decide native at-rest protection. Real-browser multi-tab
lifecycle evidence, owner-specific promotion and mixed-version fencing, runtime stale
writer recovery, native storage/security policy, recovery import, and device/simulator
acceptance remain required before authority changes.

---

## ADR-018 — Request-bound Sync v2 push-result correlation

**Accepted as an unwired pure client seam; the production coordinator remains on
`/v1`.**

The strict standalone `SyncV2PushResponse` schema can reject widened fields, future
resource sets/types/reasons, duplicate response operation ids, and malformed resources.
It cannot know which exact request was dispatched or which authenticated workspace is
current. Given a strictly parsed `SyncV2PushRequest`, its parsed response, and the
expected workspace, the pure correlator therefore requires the literal `notes-v1` set,
unique case-sensitive submitted operation ids, and exactly one applied-or-conflict result
for every submitted operation. Unknown, duplicate, and omitted results fail before any
correlated output is returned; valid results are returned in request order regardless of
response ordering or bucket.

Correlated output contains the request index plus deeply frozen copies of the complete
submitted mutation and validated server result. A later mutation of either parsed input
therefore cannot invalidate the identity, ownership, or lifecycle checks before a future
atomic consumer applies the output.

Every returned resource must retain the submitted note type and UUID identity and belong
to the expected workspace. UUID comparison is case-insensitive because PostgreSQL emits
canonical lowercase text, but the supplied request is never normalized or mutated:
receipt fingerprints bind its literal fields. Applied upserts and resurrections require a
live resource. An applied delete permits either a tombstone or the schema-defined absent
resource for a never-existing idempotent delete. A delete conflict must carry a live
authoritative resource; upsert and resurrection conflicts may carry either a live head or
tombstone. Authoritative content and version are deliberately not compared with the
mutation because tags are server-normalized, conflicts may return any current head, and
frozen receipts may replay an older valid outcome.

Focused tests cover reordered mixed results, repeated resource ids, operation-set
bijection, resource/workspace binding, the complete lifecycle matrix, canonical UUID
comparison, detached frozen results, and byte-identical frozen requests after both
rejection and deterministic replay. API-client tests separately prove that successful
widened/future response shapes
become `ApiResponseValidationError`; the correlator itself accepts typed, already-parsed
inputs rather than serving as a general wire parser.

This seam does **not** prove the supplied request was durably staged; bind device, token,
actor, or session generation; dispatch or retry network work; apply or merge results;
clear pending state; correlate pull pages; or change the coordinator, persisted root,
storage authority, server, or wire protocol. Runtime cutover still requires exact
`/v2` envelope/set/cursor persistence, checked lease/device dispatch, all-or-none result
application with newer-edit rebasing and conflict retention, durable pending clear,
`/v2` pull, terminal recovery, and restart/lost-response/stale-session evidence.

---

## ADR-019 — Transactional Sync v2 owner-root staging and push application

**Accepted as an unwired pure client kernel; production storage and network authority
remain unchanged.**

The revision-fenced repository needs one self-validating document before it can safely
store Sync v2 state opaquely. Version 3 therefore binds the canonical-lowercase
workspace+user owner, device, literal `notes-v1` set, workspace cursor, resource
projections, coalesced outbox, complete pending push envelope, durable issue, and retained
conflicts. Unknown keys, malformed or noncanonical owner UUIDs, malformed cursors, foreign
resources, duplicate resources or operation identities, divergent outbox projections,
unbacked version-zero projections, invalid lifecycle projections, and queued/conflicted
overlap fail closed. One current outbox draft owns each resource; an older exact pending
envelope may coexist only when that resource has a matching current projection. Parse and
serialize detach the complete document, whose exact bytes remain the transactional
repository's atomic compare-and-swap payload.

Pure staging validates the whole root first, leaves an existing pending request, issue,
or empty outbox unchanged, and selects at most six operations within the 1,900,000-byte
request ceiling. It persists the complete set+device+mutation envelope without consuming
the outbox. Current mutation field bounds make an individually schema-valid operation fit
the envelope; malformed persisted mutations are integrity failures, while the staging
guards remain explicit for future request-level rules or widened field bounds. A runtime
must commit the returned whole root before it may dispatch those exact bytes.

Pure application requires a valid root with no durable issue, the exact pending envelope,
and matching workspace and device context. It strictly parses the supplied request and
response and invokes ADR-018 correlation before constructing output. Applied results
replace the resource projection with authoritative server state or remove an absent
idempotent delete; a single newer local draft is rebased onto the returned positive
version while retaining its content, explicit lifecycle, and local edit timestamps.
Version-zero server results fail before acknowledgement. Conflict outcomes normally remove
the queued draft but keep that newest local mutation beside the exact server resource; a
post-dispatch draft may have a different lifecycle from the operation that produced the
conflict. The replay-safe exception is a newer local delete beside a returned tombstone:
that draft is rebased and requeued rather than converted to a conflict or consumed. The
result may be a frozen receipt older than a later server resurrection, so only another
idempotent push or current conflict can safely settle that intent. When one request contains
several operations for the same resource, only its final request-ordered result defines the
final authoritative head. Success returns one complete root with
`pendingPush: null`; any error leaves every input object and the durable pending envelope
untouched.

Focused tests cover strict root ownership and internal consistency, opaque repository
round-trip, restart replay, staging gates and operation bounds, exact context/request
fences, lifecycle outcomes, reordered and repeated-resource results, newer-edit rebasing,
multi-conflict retention, input detachment, and atomic failure. The existing production
coordinator imports none of these modules and continues to persist version 2 through
SecureStore/localStorage and dispatch `/v1`.

This decision does **not** promote IndexedDB, add or select native SQLite, coordinate
cross-tab ownership, bind dispatch to a live session lease, call `/v2`, apply pull pages,
clear terminal recovery issues, import quarantined legacy state, or provide browser and
native acceptance evidence. Those remain runtime-cutover and release gates.

---

## ADR-020 — Native SQLite transactional owner-replica store

**Accepted as an unwired native storage primitive; runtime authority is unchanged.**

ADR-017 gave web a revision-fenced transactional owner-replica store on IndexedDB, but
native had none — the shipped native replica is still one size-limited `expo-secure-store`
value (a ~2 KB Android ceiling), so a real workspace cannot durably persist on device.
That is the #1 launch blocker in the master plan.

`ExpoSqliteTransactionalReplicaStore` is the native counterpart. It implements the exact
same `TransactionalReplicaStore` contract as the IndexedDB store — `read` plus an atomic
`compareAndSwap(ownerKey, expectedRevision, bytes)` that creates revision 1 from 0,
replaces at the observed revision, and returns the authoritative record on any revision
mismatch without overwriting it — so the existing `TransactionalOwnerReplicaRepository`
(queueing, read-back verify, stale-writer fence) works over it unchanged. One SQLite row
per owner holds `{schema_version, owner_key, revision, serialized_replica}`; the swap runs
inside an EXCLUSIVE (write-locked) transaction, which is the primitive that serializes
concurrent swaps. A misrouted/corrupt row fails loud, exactly like the web store.

The store depends only on a tiny async SQLite seam (`ReplicaSqliteDatabase`): the app
satisfies it with an `expo-sqlite` database (via a lazily-imported factory so neither the
module nor its tests load the native binding), and the tests satisfy it with Node's
built-in `node:sqlite`. The full compare-and-swap contract — create/read/revision
monotonicity, conflict-without-overwrite, owner isolation, repository fencing, corrupt-row
rejection, and the exclusive-lock primitive — therefore runs against **real SQLite
off-device** and is green in CI.

This decision does **not** select SQLite in production, promote the existing
SecureStore/localStorage replica, change the `/v1` coordinator or the persisted root
shape, or move the bearer token out of the OS keystore. Native force-quit durability and
true multi-connection concurrency are **device-acceptance gates** (as the IndexedDB
primitive's real-browser behavior is), and the fenced storage cutover — selecting this
store for native, promoting existing replicas, and porting the coordinator to `/v2` — is
the runtime work tracked as plan item A3.

---

## ADR-021 — Append-only stale-CAS recovery journal and read-only recovery mode

**Accepted for the v2 owner-replica runtime; transactional authority remains default-off.**

ADR-017 deliberately fences a repository instance after a different-byte revision conflict.
Clearing that storage fence requires an authoritative read, but the application must not publish
the winner and discard its optimistic loser before proving that the losing branch is recoverable.
The v2 store therefore stages every exact losing serialized owner root in an owner-scoped pending
set before starting the authoritative read. A final per-owner recovery barrier shares that read
across overlapping losers and publishes a valid winner only after every pending candidate is
verified in the recovery journal. Any failed append retains the exact candidate and application
fence for same-process retry; no losing durability promise is reported as successful. That pending
set is memory-only: if the selected repository is failing and the process dies before a retry, this
slice cannot claim that candidate is crash-durable.

The journal uses the same owner-repository boundary under a domain-separated synthetic key. Its
versioned envelope has exact keys, immutable source ownership, monotonically contiguous sequence
numbers, ISO capture times, a bounded reason vocabulary, and deduplication by exact serialized
bytes. Embedded snapshots must have the exact current v2 owner-root key set and owner identity;
credential-like fields at any nesting level fail closed. The bearer session remains only in
session storage. Journal writes serialize in process, and independent transactional repository
instances merge after stale CAS rather than replacing another candidate. The legacy
`SerializedKvReplicaRepository` has no cross-process compare-and-swap, so its concurrent journal
writers retain last-write-wins limitations; transactional authority remains required for that claim.

Missing, corrupt, foreign, or future-version primary authority is never normalized or overwritten.
When a transactional adapter rejects corrupt primary metadata before returning serialized bytes,
the loader still checks the separately keyed recovery journal.
If a compatible journal snapshot exists, a later session load projects the newest compatible
candidate with status `recovery-required`; leases, editing, sync, conflict resolution, history
mutations, billing/token actions, and remote export remain disabled. The app shows a shared
read-only recovery notice while keeping local inspection and the sign-out action available;
sign-out retries preservation and refuses the transition when it cannot verify the journal.
Ordinary persisted-session hydration cannot create an empty replacement; the sole exception is
the explicit verified v1 migration path. Session departure flushes every pending exact candidate
before writing a tombstone or changing owners. A server-rejected credential still gets
tombstoned even if recovery storage fails, but that partial outcome throws so callers can observe
it. A 401 for the exact still-active bearer remains authoritative when recovery has invalidated
the operation lease; matching the active token and owner still prevents a late A response from
expiring B.

Recovery records are append-only in this slice. There is intentionally no automatic deletion,
winner selection, merge, export, import, or discard, and a valid authoritative winner may remain
the live projection after its losers are journaled. Recovery data duplicates private note content
inside the selected local repository, so the native at-rest policy and eventual local-account
erasure must cover both primary and synthetic keys.

This is **not** the mixed-version promotion divergence protocol: it cannot stop an already-loaded
old client from writing the legacy key, elect a browser leader, gate old server clients, or prove
real browser/native lifecycle behavior. `EXPO_PUBLIC_DURABLE_STORAGE` therefore stays off by
default. The legacy/primary divergence journal, Web Lock leadership, enforceable compatibility
contract, recovery resolution/export controls, storage-erasure path, and acceptance evidence
remain explicit A3 release gates.

---

## Summary: the shape these decisions produce

One TypeScript monorepo → one Fastify service → one Postgres (PGlite locally). Auth,
notes+versions, agent tokens, activity log, sync change-feed, billing, and export are all
routes on that one service, all workspace-scoped, all sharing types with a Legend-State
local-first Expo client that runs on iOS, Android, and web. Boring on purpose.
