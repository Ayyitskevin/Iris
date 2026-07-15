# Iris — Roadmap & Deferred Work

This file exists so that scope discipline is _visible_. The brief lists explicit
non-goals for the foundation and asks that anything we're tempted to add be written down
here instead of smuggled into the vertical slice. Deferred sections below are
**intentionally not built yet**; shipped work is recorded separately.

## Non-goals for the foundation (resisted on purpose)

These were named as out of scope and are staying out until the foundation is proven:

- **Real-time multi-human co-editing.** Would justify a CRDT text type (see ADR-005). Our
  single-operator conflict model (version-based, surfaced) is correct until then.
- **Teams / roles / permission schemes** beyond one owner per workspace. The membership
  table exists as a _seam_ (a `workspace_members` row with a `role` column defaulting to
  `owner`), but invites, multiple roles, and org management are not built.
- **Block editor / databases / tables** (Notion parity). The editor is a Markdown view,
  full stop.
- **AI generating content inside Iris.** We _expose_ agents via API; we do not ship a
  model. No inference runs in Iris.
- **Plugins / marketplace.**
- **Desktop-native apps.** (Web covers desktop for now.)
- **Graph view / backlinks polish.**

## Documented seams (built to be extended, not extended yet)

- **Auth provider** — `AuthProvider` interface with a local implementation; Clerk/Supabase
  drop in behind it (ADR-004).
- **Workspace membership** — `workspace_members(role)` is present; multi-user/roles land here.
- **Token scopes** — `notes:read` / `notes:write` today; finer scopes (per-folder, admin)
  extend the same `scopes` array.
- **Organization primitive: folders** — the foundation's primary primitive. **Tags shipped
  in phase 2** (ADR-010) as an orthogonal `jsonb` array on notes; folders remain primary.

## Shipped after the foundation

- **Phase 2 — tags + full-text search** (ADR-010): versioned `jsonb` tags with list/filter,
  and ranked Postgres FTS over a generated `tsvector` column. Client: search bar (server FTS
  with an offline fallback) and tag chips/input.
- **Phase 2.1a — lossless reconciliation contract** (ADR-011): a pure client kernel and
  focused tests encode exact operation acknowledgement, in-flight edit rebasing,
  multi-conflict retention, and complete pull pagination.
- **Phase 2.1b — owner isolation + runtime reconciliation** (ADR-011): credentials are
  separate from owner-keyed replicas; v1 migration creates a verified recovery copy and
  activates only attributable data; fixed-token, generation-bound sync cycles reject
  stale responses; conflicts persist in a Review inbox. Concurrency tests cover delayed
  requests, sign-out, account switching, stale 401s, cursor isolation, and
  A-outbox/B-token separation.

## Near-term follow-ups (next things)

1. **Sync v2 + transactional local repository**: monotonic database cursor,
   request-bound server idempotency, generic resource envelopes, SQLite on native,
   IndexedDB plus cross-tab session coordination on web, transactional note+outbox writes,
   and a user-facing recovery/import path for quarantined v1 data.
   The current size-limited per-owner SecureStore value and timestamp cursor are explicit
   release blockers.
2. **Agent-delegated work queue**: projects and tasks with status, priority, due date, one
   accountable human-or-agent assignee, reversible writes, and the same sync resource
   envelope. Keep activity, check-in, delegation, and durable claim/run semantics
   distinct.
3. **Managed auth provider** wired for real (Clerk or Supabase) + password reset + OAuth +
   email verification — these are the managed provider's job, not `LocalAuthProvider`'s.
4. **Attachment storage** to object storage (S3/R2) with the same export guarantee;
   foundation stores attachment metadata and includes files in export, but a production
   blob store + upload flow is a follow-up.
5. **Rate limiting** for agent tokens beyond the coarse fixed-window limiter (per-scope
   budgets, sliding window, 429 semantics).
6. **Stripe hardening**: proration, plan changes, dunning, customer portal, tax.
7. **EAS Build + store submission** pipeline and OTA update channels.
8. **Editor upgrades**: live Markdown preview, slash-menu, image paste — still emitting
   plain Markdown.
9. **Search/tags upgrades**: tag rename/merge, search snippets & highlighting, filter by
   tag _and_ query together, per-field ranking weights.

## Tempted-but-parked ideas (write here, don't build)

- Backlinks / `[[wikilink]]` graph — fits the product, but polish is a non-goal now.
- Agent "runs" grouping (a batch of agent actions as one undoable unit) — natural
  extension of the activity log; parked until the single-action feed is proven in use.
- Per-workspace encryption-at-rest keys for a stronger "you own your data" story.
- Webhooks so agents can _subscribe_ to note changes (today they poll the change-feed).

## Product horizon after Sync v2

1. **Connected work graph** — projects/tasks, typed links between work and knowledge,
   dependencies, saved views, and a focused mobile Today/Review surface.
2. **Knowledge graph** — spaces, hierarchical pages, backlinks, attachments, and
   Obsidian/Notion import through a versioned dry-run/manifest pipeline.
3. **Agent control plane** — durable run state, claim/lease semantics, approvals,
   cancellation/resume, bounded context packets, outputs, and lineage.

Each domain must inherit the same ownership guarantees: local-first writes, attributed
actors, reversible history, bounded permissions, and full portable export.
