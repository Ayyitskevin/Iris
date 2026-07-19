# Iris

> A notes-and-knowledge app for solo operators who run AI agents alongside themselves.
> Notion's polish, Obsidian's data-ownership feel — rebuilt so **agents are first-class
> actors**, not a chat sidebar. iOS, Android, and web from one TypeScript codebase.

**Iris = the messenger** (your agents carry work back to you) **and iris = the eye** (you
watch and steer them). Herald + watcher.

Read [`docs/VISION.md`](docs/VISION.md) for the thesis and the three pillars, and
[`docs/DECISIONS.md`](docs/DECISIONS.md) for why the stack is what it is. This README is
how to run it.

---

## What's in this foundation

A thin, end-to-end vertical slice that proves the architecture:

- **Multi-tenant auth + workspaces** — sign up → your own isolated workspace.
- **Notes core** — create/edit/delete Markdown notes in folders, with versioned content
  history and forward-only restore. **Tags + full-text search** (phase 2, ADR-010):
  ranked search and tag filtering, both workspace-scoped. New history snapshots restore
  folders, tags, and live/deleted state exactly; legacy snapshots expose unknown state
  instead of pretending it was captured (ADR-013/014).
- **Owner-isolated local-first sync** — edits apply instantly/offline; each user/workspace
  has a private replica and fixed-token sync lease; a change-feed reconciles to Postgres;
  conflicts retain both versions in a dedicated Review inbox. A strict, note-backed
  generic resource envelope is available additively on `/v2/sync/*` for the future work
  graph while the current mobile coordinator stays on the frozen `/v1` transport.
- **Agent actors + API** — issue scoped, revocable agent tokens; a REST API that agents
  and the app share; every agent note write lands in an **append-only activity log** and
  creates a version; an **activity feed** where the operator can undo recorded content
  changes.
- **Billing gate** — Stripe subscription; local use free, multi-device **sync is the paid
  line** (~$5/mo).
- **Portable Markdown note export** — the API/web flow produces a zip of `.md` files plus
  a manifest. Attachment storage/export and native share-sheet UX are not built yet.

## Repository layout

```
iris/
├── apps/
│   ├── api/            Fastify + Drizzle backend (the system of record)
│   └── mobile/         Expo (Expo Router) client → iOS, Android, web
├── packages/
│   └── shared/         zod schemas + typed API client shared by api and mobile
└── docs/               VISION, DECISIONS (ADRs), ROADMAP
```

## Prerequisites

- Node ≥ 22, pnpm ≥ 10.
- **No database, Docker, or cloud accounts required** to run and test the backend: it uses
  [PGlite](https://pglite.dev) (Postgres compiled to WASM, in-process) when `DATABASE_URL`
  is unset. See [ADR-002](docs/DECISIONS.md).

## Quick start

```bash
pnpm install

# Backend — runs on PGlite with local auth and a fake Stripe; zero config.
pnpm dev:api            # http://localhost:4000  (health: GET /health)

# Tests — the Definition-of-Done proofs run here (tenant isolation, agent→undo, etc.)
pnpm test

# Client — Expo dev server (press w for web, or scan the QR for a device)
pnpm dev:mobile
```

Copy `.env.example` → `apps/api/.env` for server values and → `apps/mobile/.env` for
`EXPO_PUBLIC_*` client values. Fill only the runtime you are exercising (real Postgres via
`DATABASE_URL`, managed auth via `AUTH_PROVIDER`, live Stripe keys, or durability test flags).

## Try the agent flow by hand

```bash
# 1. Sign up (returns a user session token)
curl -s localhost:4000/v1/auth/sign-up -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"correct-horse-battery","displayName":"Me"}'

# 2. Issue an agent token (use the session token from step 1 as Bearer)
curl -s localhost:4000/v1/agents/tokens -H "authorization: Bearer <SESSION>" \
  -H 'content-type: application/json' -d '{"agentName":"Researcher","scopes":["notes:read","notes:write"]}'

# 3. The agent writes a note with ITS token
curl -s localhost:4000/v1/notes -H "authorization: Bearer <AGENT_TOKEN>" \
  -H 'content-type: application/json' -d '{"title":"From the agent","bodyMd":"# Hello"}'

# 4. See it in the activity feed, then undo it
curl -s localhost:4000/v1/activity -H "authorization: Bearer <SESSION>"
curl -s localhost:4000/v2/activity/<ACTIVITY_ID>/undo -X POST -H "authorization: Bearer <SESSION>"
```

## Scripts

| Command            | What it does                                |
| ------------------ | ------------------------------------------- |
| `pnpm dev:api`     | Run the API (watch mode) on PGlite          |
| `pnpm test`        | Run the API and mobile test suites (Vitest) |
| `pnpm typecheck`   | `tsc --noEmit` across all packages          |
| `pnpm lint`        | ESLint across the monorepo                  |
| `pnpm format`      | Prettier write                              |
| `pnpm dev:mobile`  | Expo dev server (iOS / Android / web)       |
| `pnpm db:generate` | Generate Drizzle SQL migration from schema  |
| `pnpm db:migrate`  | Apply migrations                            |

## Status & honesty note

See the bottom of [`docs/DECISIONS.md`](docs/DECISIONS.md) and
[`docs/ROADMAP.md`](docs/ROADMAP.md). The PGlite-backed API suite and mobile suites run
and pass in-repo. Auth ships a **local** provider behind a managed-provider seam
(ADR-004); Stripe ships full plumbing tested with a fake client (ADR-007). The production
mobile loop now uses the lossless reconciliation contract behind owner-keyed replicas
and immutable session leases. Phase 2.2a delivers Sync v2's durable transport half, not the
whole protocol or release readiness: current clients durably stage exact push chunks
within six operations and a 1,900,000-byte serialized request budget; the same
`/v1/sync/push` ingress applies that finite cap to every client beneath Fastify's
separate 2,097,152-byte ingress ceiling, with a 1,900,000-byte worst-case response
budget for notes accepted under the current bound. A migrated pre-limit oversized note
remains lossless and may occupy one conflict response beyond that modern-data budget.
Each sync cycle durably drains at most 16 chunks (96 operations) and leaves any
larger remainder for the next cycle. Pull pages are bounded by both rows and bytes.
Retries are bound to actor + explicitly user-registered, workspace-composite device +
payload + frozen receipt version; cursors bind a commit-serialized sequence to one
workspace. Terminal protocol failures persist an owner-local hold and require a visible
manual recovery action before networking resumes.
A checksummed migration ledger adopts only recognized legacy postconditions and verifies
every applied additive safety signature, including Sync v2 and organizational-history
artifacts, on later runs. Focused tests cover transport bounds, lost
responses, persistence races, exact applied/conflict replay, non-`BYPASSRLS`
upgrade-with-data, delayed push/pull, pagination, sign-out, account switch, stale 401,
cross-workspace cursor rejection, and A-outbox/B-token separation (ADR-011/012). The
strict `notes-v1` resource envelope now coexists on `/v2/sync/*`: its immutable
resource-set cursor cannot cross routes or workspaces, and exact note operations replay
the frozen receipt-v1 outcome across `/v1` and `/v2` without another resource mutation,
receipt, or logical cursor advance (ADR-016).
The production mobile coordinator intentionally remains on `/v1`. Revision-fenced
IndexedDB and SQLite stores, lazy legacy promotion, and the platform selector now exist,
but `EXPO_PUBLIC_DURABLE_STORAGE` defaults off, so the size-limited
SecureStore/localStorage adapter remains authority. A stale CAS now stages every exact losing
owner root in a strict credential-free, append-only recovery journal before the final recovery
barrier may publish a valid winner. Missing, corrupt, or future-version authority stays untouched;
on a later login Iris can reopen the newest compatible recovery snapshot in a visible read-only
`recovery-required` mode instead of creating an empty root. Sign-out and account switching
proceed only after pending recovery candidates are verified. A failed append retains its exact
candidate only for same-process retry; it cannot be crash-durable while the selected repository is
failing. Cross-process journal union requires the transactional CAS repository; the default legacy
adapter remains last-write-wins. Settings now links to an owner-fenced Recovery Center in both
ordinary error and read-only recovery states. It inventories journal-verified, memory-only, and
distinct displayed branches with bounded previews and can create a strict token-free local JSON
bundle. Export first makes every already-staged branch journal-durable and aborts rather than claim
an incomplete bundle; it never writes the primary root or calls the Iris API. Web requests a Blob
download. Native verifies an app-private cache file byte-for-byte, opens the share sheet, retains
the handed-off file long enough for receivers, and attempts to purge Iris-owned cache files with
verified timestamps older than 24 hours on a later launch/export. Unknown timestamps are retained;
cleanup failures are surfaced without blocking a separately named export. Neither platform claims
that the user retained the destination file.
With the flag explicitly enabled in a capable browser, one owner-scoped Web Lock now grants
commit/sync authority. Other current-runtime tabs are visibly read-only, make no sync request, and
reread durable state after exact metadata-only BroadcastChannel notices; a production-bundle
two-tab Chromium gate proves transfer with pending work intact. Capabilities absent during startup
selection choose the exact legacy adapter; a later authority failure instead pauses fail-closed.
ADR-023 now wraps promotion and primary saves in a strict digest-only authority journal. It
rechecks the immutable exact legacy baseline around each commit and immediately before every
authenticated fetch; drift preserves valid primary, legacy, and optimistic branches in the
token-free Recovery Center journal, invalidates active leases, and sends no later request. A
CAS-safe transactional checkpoint bounds routine completed control history after 64 entries while
retaining preparing/diverged evidence. A production-bundle frozen old-writer Chromium journey
proves that containment without importing current lock code. The flag is still not cutover-safe or default-on: client-only code detects but
cannot stop an already-loaded old tab/version from writing the legacy copy. An enforceable
human-approved server compatibility gate, recovery choose/restore/import/discard controls, the v2
pull applier, at-rest policy, and native lifecycle acceptance—including initial reload recovery
presentation—remain open. See
`docs/MASTER_PLAN.md` for the ordered release gates.
GitHub Actions run `29506816638` passed the PostgreSQL 16
independent-connection commit-order and concurrent device-gate gate for commit
`8a8785114623d3e601f26ddf7b6eed21b23415cf`.

ADR-013 adds migration `0004` and closes folder/tag parity for new version snapshots,
direct restore, and head-safe activity undo. GitHub Actions run `29512373454` passed
that exact slice at commit `06d3f4e958f1747a767d8592bef48eb164e0c012`.

ADR-014 adds migration `0005` and a tri-state lifecycle snapshot: `false` is captured
live, `true` is captured deleted, and SQL `NULL` is legacy unknown. Direct restore and
whole-snapshot undo now reconstruct known lifecycle state; legacy restore requires
explicit preservation, while incomplete undo fails without a fake compensating write.
Restore/undo protocol 2 uses distinct `/v2` mutation paths, and the retired v1 paths
return 428 so mixed old/new routing cannot silently apply legacy always-revive semantics.
GitHub Actions run `29516023454` passed that exact slice at commit
`ce0bd965d75529db9823eb227ff183c4408b9a28`.

ADR-015 separates an explicit, receipt-bound `resurrect` from ordinary upsert. A normal
edit now retains an authoritative tombstone as a conflict; only “Restore my draft” can
create a live head, recorded as reversible `note.restore` activity. Exact retries replay,
old/new binaries fail closed, and edits on either side of durable request staging keep
their intended lifecycle and newest Markdown payload.

ADR-016 adds strict `/v2/sync/changes` and `/v2/sync/push` resource envelopes without
changing `/v1`, the database, or receipt storage. `notes-v1` membership is immutable;
its cursor binds the set, workspace, and commit-serialized high-water mark. Generic note
pushes project losslessly into receipt version 1, so a lost response can retry through
either route exactly once. Wrapped pull and push responses retain the finite transport
budgets and the single recognized legacy-oversize exception. This is the generic
protocol seam, not the mobile runtime cutover or a claim that projects/tasks exist.

ADR-017 adds the unwired web storage primitive: an opaque whole-root IndexedDB record
keyed by owner and guarded by a hidden monotonic revision. Atomic compare-and-swap
transactions reject stale tabs without overwriting the winner; an explicit authoritative
read is required before the losing projection may write again. Node tests exercise the
IndexedDB API and transaction semantics through `fake-indexeddb`, but no deployed storage
authority, native backend, coordinator route, or persisted replica shape changed.

ADR-018 adds a pure, unwired `/v2` push-result correlator. Given a strictly parsed
request and response plus the expected workspace, it requires a one-to-one operation
result set, returns request order, and rejects wrong resource identity, workspace, or
lifecycle semantics without mutating the request. Returned operation and result snapshots
are deeply frozen and do not expose request/response aliases. The production coordinator
still uses `/v1`; this does not stage, dispatch, retry, apply, or durably clear a `/v2`
request.

ADR-019 adds the next unwired client kernel: a strict version-3 owner root persists the
literal resource set, workspace-bound cursor, resource projection, coalesced outbox,
complete pending `/v2` envelope, durable issue, and retained conflicts as one opaque
transactional document. Pure staging preserves an exact request without consuming the
outbox, and pure application binds an exact durable request through ADR-018 before it
atomically clears pending work, applies authoritative heads, rebases one newer local
draft (including replay-safe retention of a newer delete), or retains both sides of a
conflict. IndexedDB and the production coordinator do not import this kernel;
localStorage/SecureStore and `/v1` remain runtime authority.
