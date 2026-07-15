# Iris skills — handoff library

Task-oriented guides to the Iris codebase. Each skill is a `SKILL.md` with the same
shape: **When to use · Mental model · Key files · Playbook · Invariants & gotchas**.
Open the one whose "When to use" matches your task; every guide is cross-checked against
the real code and cites the files (and line numbers) it describes.

## Recommended reading order

Start with **architecture-overview** — it is the whole-repo map and links out to every
other skill. After that, read in roughly this order (foundations → request path →
domain pillars → client/test/reference), or jump straight to whatever your change touches.

1. **architecture-overview** — the map; read first, always.
2. **tenant-isolation** — the workspace-scoping invariant everything else assumes.
3. **database-and-migrations** — schema, hand-authored SQL migrations, RLS, the two DB drivers.
4. **add-an-api-route** — the end-to-end recipe for a new endpoint (ties the above together).
5. **notes-and-versioning** — note CRUD, the version/conflict choke point.
6. **activity-and-undo** — the append-only feed and reversible-action model (pillar #2).
7. **agent-actors-and-tokens** — scoped hashed tokens, the `Principal`, scope enforcement.
8. **sync-protocol** — the local-first change-feed: cursor pulls, base_version pushes, conflicts.
9. **billing-and-the-sync-gate** — Stripe seam and the multi-device 402 gate.
10. **auth-provider-seam** — swapping local auth for a managed provider (Clerk/Supabase).
11. **client-architecture** — the Expo/Legend-State mobile client.
12. **testing** — the `apps/api` black-box harness (`makeApp`/`call`/`signUp`).
13. **conventions-and-gotchas** — pinned versions, imports, error/serializer rules; reference/last.

## Index

| Skill | What it's for |
| --- | --- |
| [architecture-overview](architecture-overview/SKILL.md) | Start here when you're new to Iris or unsure where a feature lives — the whole-repo map and how one API request flows from route to database. |
| [tenant-isolation](tenant-isolation/SKILL.md) | Read before writing or reviewing any query, table, migration, or service — how workspace scoping is enforced end to end and how to avoid punching a hole in it. |
| [database-and-migrations](database-and-migrations/SKILL.md) | Open when changing the DB — adding a table/column, writing a migration, adding RLS for a new tenant table, or debugging PGlite-vs-Postgres behavior. |
| [add-an-api-route](add-an-api-route/SKILL.md) | Open when adding, extending, or debugging a REST endpoint on apps/api — the end-to-end recipe from zod schema to client method to route to service to test. |
| [notes-and-versioning](notes-and-versioning/SKILL.md) | Open when touching note CRUD, version history, the baseVersion 409-conflict path, restore/undo, or soft delete — anything that mutates a note or reads its history. |
| [activity-and-undo](activity-and-undo/SKILL.md) | Open when touching the activity feed, the undo endpoint, note_versions/activity_log rows, or debugging why an action shows (or won't show) as undone. |
| [agent-actors-and-tokens](agent-actors-and-tokens/SKILL.md) | Open when issuing, hashing, scoping, verifying, or revoking agent tokens, debugging agent 401/403s, or adding/changing agent scopes. |
| [sync-protocol](sync-protocol/SKILL.md) | Open when touching the local-first change-feed — cursor pulls, base_version pushes, conflict surfacing, the outbox, or the client sync() loop (ADR-005). |
| [billing-and-the-sync-gate](billing-and-the-sync-gate/SKILL.md) | Open when touching Stripe/checkout/webhooks, the multi-device 402 gate, subscription state, or writing/fixing tests that drive billing without live keys. |
| [auth-provider-seam](auth-provider-seam/SKILL.md) | Open when swapping Iris's local email+password auth for a managed provider (Clerk/Supabase), adding OAuth/password-reset/email-verification, or changing how sign-up provisions a tenant. |
| [client-architecture](client-architecture/SKILL.md) | Open when working on the Expo mobile client — routing/navigation, the Legend-State local-first store, the sync manager, the shared API client, or adding a screen/tab. |
| [testing](testing/SKILL.md) | Open this when writing or debugging an apps/api test — how makeApp()/call()/signUp() work, the forced PGlite/local/fake-Stripe env, and how to add a DoD-style black-box test. |
| [conventions-and-gotchas](conventions-and-gotchas/SKILL.md) | Open before bumping a dependency, touching tsconfig/eslint/imports, adding an error path or serializer, or when a build/lint/typecheck breaks after an upgrade — the pinned versions and traps that already bit us. |

## Source-of-truth notes

- **Code wins over prose.** These skills describe the shipped code and cite it by
  file/line. If an ADR in `docs/DECISIONS.md` ever disagrees with the code, trust the code
  and fix the doc — the concrete contracts (the RLS GUC name `app.current_workspace`, the
  `AuthProvider` `signUp`/`signIn` shape, the `.data/iris` PGlite path) live in the source,
  not the prose.
- **Rationale ("why") lives in `docs/DECISIONS.md` (ADRs); product scope in `docs/VISION.md`.**
  The skills cover "what the code does and how to change it safely."
