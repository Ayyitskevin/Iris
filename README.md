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
  folders and tags exactly; legacy snapshots expose unknown folder state instead of
  pretending it was captured (ADR-013).
- **Owner-isolated local-first sync** — edits apply instantly/offline; each user/workspace
  has a private replica and fixed-token sync lease; a change-feed reconciles to Postgres;
  conflicts retain both versions in a dedicated Review inbox.
- **Agent actors + API** — issue scoped, revocable agent tokens; a REST API that agents
  and the app share; every agent note write lands in an **append-only activity log** and
  creates a version; an **activity feed** where the operator can undo recorded content
  changes.
- **Billing gate** — Stripe subscription; local use free, multi-device **sync is the paid
  line** (~$5/mo).
- **Full Markdown export** — one action → a zip of `.md` files + attachments.

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

Copy `.env.example` → `apps/api/.env` and fill values to move toward production
(real Postgres via `DATABASE_URL`, managed auth via `AUTH_PROVIDER`, live Stripe keys).

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
curl -s localhost:4000/v1/activity/<ACTIVITY_ID>/undo -X POST -H "authorization: Bearer <SESSION>"
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
cross-workspace cursor rejection, and A-outbox/B-token separation (ADR-011/012). Generic
resource envelopes, transactional SQLite/IndexedDB replicas, web cross-tab coordination,
recovery import, and native device/simulator acceptance remain explicit release blockers.
GitHub Actions run `29506816638` passed the PostgreSQL 16
independent-connection commit-order and concurrent device-gate gate for commit
`8a8785114623d3e601f26ddf7b6eed21b23415cf`.

ADR-013 adds migration `0004` and closes folder/tag parity for new version snapshots,
direct restore, and head-safe activity undo. History responses bind restore to one
authoritative head and advertise the safe protocol. New clients disable mutation against
non-current protocol while retaining read-only history/activity; the new server rejects
old restore requests that lack a precondition. Old snapshots preserve a visibly
unknown folder rather than silently treating SQL `NULL` as historical root.
Deleted/tombstone state is not yet part of version snapshots, so exact undo of a restore
or sync revival remains a tracked correctness gap in ROADMAP.
