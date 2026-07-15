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
- **Notes core** — create/edit/delete Markdown notes in folders, **versioned** (every save
  keeps history; restore any prior version). **Tags + full-text search** (phase 2, ADR-010):
  ranked search and tag filtering, both workspace-scoped.
- **Local-first sync** — edits apply instantly/offline; a change-feed reconciles to
  Postgres; conflicts are **surfaced, never dropped**.
- **Agent actors + API** — issue scoped, revocable agent tokens; a REST API that agents
  and the app share; every agent write lands in an **append-only activity log** and creates
  a version; an **activity feed** where the operator can **undo** an action.
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

| Command | What it does |
| --- | --- |
| `pnpm dev:api` | Run the API (watch mode) on PGlite |
| `pnpm test` | Run the API test suite (Vitest) |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm lint` | ESLint across the monorepo |
| `pnpm format` | Prettier write |
| `pnpm dev:mobile` | Expo dev server (iOS / Android / web) |
| `pnpm db:generate` | Generate Drizzle SQL migration from schema |
| `pnpm db:migrate` | Apply migrations |

## Status & honesty note

See the bottom of [`docs/DECISIONS.md`](docs/DECISIONS.md) and
[`docs/ROADMAP.md`](docs/ROADMAP.md). The backend and its Definition-of-Done tests run and
pass in-repo. Auth ships a **local** provider behind a managed-provider seam (ADR-004);
Stripe ships full plumbing tested with a fake client (ADR-007). Device/simulator app runs
require the standard Expo/EAS toolchain and are a documented follow-up.
