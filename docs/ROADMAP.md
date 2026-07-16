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
  separate from owner-keyed replicas; legacy `iris:state:v1` recovery creates a verified
  copy and activates only attributable data; fixed-token, generation-bound sync cycles
  reject stale responses; conflicts persist in a Review inbox. Concurrency tests cover
  delayed requests, sign-out, account switching, stale 401s, cursor isolation, and
  A-outbox/B-token separation.
- **Phase 2.2a — durable Sync v2 transport half** (ADR-012; not full Sync v2 or release
  readiness): note writes receive commit-serialized workspace sequences; operation ids
  are permanently bound to one actor/device/payload/receipt version and replay their
  transactionally stored outcome; workspace-bound cursors reject cross-owner reuse;
  every existing-note update path uses CAS; note and device identities are
  workspace-composite; and only an explicit signed-in-user registration may allocate a
  device before push or pull. Current clients greedily persist exact requests within six
  operations and a 1,900,000-byte serialized request budget; the same
  `/v1/sync/push` ingress enforces that finite cap for every client beneath Fastify's
  separate 2,097,152-byte ingress ceiling, and its worst-case result for currently
  bounded notes fits a 1,900,000-byte response budget. A migrated pre-limit oversized
  note remains lossless and may occupy one conflict response beyond that budget. A
  cycle durably drains at most 16 chunks (96 operations) and leaves any larger
  remainder for the next cycle. Pull is row- and
  byte-bounded. The checksummed runner verifies current-head migration artifacts, and
  durable terminal issues stop network work until a visible manual recovery action.
  Upgrade-with-data, RLS-role, collision, rollback, transport-bound, lost-response,
  failed-save interleaving, restart, large-outbox, and newer-edit rebasing tests cover
  the PGlite/mobile boundary. GitHub Actions run `29506816638` passed the PostgreSQL 16
  independent-connection commit-order and device-gate concurrency test for commit
  `8a8785114623d3e601f26ddf7b6eed21b23415cf`.
- **Phase 2.3 — organizational history parity** (ADR-013): new version snapshots capture
  folders and tags exactly; direct restore and activity undo restore both fields while
  preserving append-only history. Migration `0004` backfills only the provably matching
  current-head snapshot and marks older folders unknown. Legacy uncertainty is visible,
  direct restore requires the authoritative head returned with history, and whole-note
  undo refuses to overwrite a later action. Versioned restore/undo capabilities disable
  unsafe mutation across a mixed old/new deployment while leaving unknown future
  protocols readable; response payloads are runtime validated. Focused tests cover exact
  root/folder distinctions, stale restores and undos, route/request invalidation,
  unconfirmed mutation outcomes, explicit legacy preservation, tenant isolation, and
  fail-loud incomplete undo history.
- **Phase 2.4 — tombstone history parity** (ADR-014): migration `0005` stores logical
  live/deleted state as a tri-state snapshot with no default, backfilling only provable
  current heads and leaving older/old-binary rows unknown. Direct restore reconstructs
  known lifecycle state or requires explicit legacy preservation; whole-snapshot undo
  fails closed on unknown state and can re-tombstone a direct or sync revival. Protocol
  2 moves restore/undo mutations to distinct `/v2` paths while retired v1 paths return
  428, so a mixed binary cannot reinterpret the new semantics. Successful undo returns
  the authoritative note including tombstones for immediate replica fencing. Focused
  tests cover restore-to-delete, undo-delete, undo-create, restore/sync revival undo,
  legacy uncertainty, migration drift/RLS, and mixed-path no-mutation behavior.
- **Phase 2.5 — explicit sync resurrection** (ADR-015): ordinary upsert never clears a
  tombstone; only an exact-base `resurrect` chosen from the retained conflict draft can
  make it live. The operation type is bound by the existing frozen receipt fingerprint,
  successful revival records reversible `note.restore` activity, and old/new binaries
  reject or retain the intent without silently reinterpreting it. Mobile queue collapse
  preserves unstaged resurrection intent and rebases edits made after durable staging.
- **Phase 2.6 — additive generic resource transport seam** (ADR-016): strict
  `/v2/sync/changes` and `/v2/sync/push` routes expose the immutable `notes-v1` resource
  set without changing `/v1`. Set/workspace-bound cursors advance through one captured
  commit high-water mark, full wrapped pages remain byte-bounded, and note envelopes
  project losslessly into frozen receipt version 1 so exact retries can cross routes
  without another resource mutation, receipt, or logical cursor advance. The shared API
  client validates the new responses, but the
  production mobile coordinator intentionally remains on `/v1` pending transactional
  platform repositories; no project/task resource or migration was added.
- **Phase 2.7 — revision-fenced IndexedDB foundation** (ADR-017): an unwired web store
  preserves each opaque serialized owner root behind an atomic monotonic-revision
  compare-and-swap. Same-owner operations are queued, separate connections cannot both
  win one revision, exact committed bytes are verified, and a stale writer is fenced
  until an explicit authoritative read. Evidence currently comes from Node plus
  `fake-indexeddb`; localStorage remains production authority and no native code changed.
- **Phase 2.8 — request-bound Sync v2 push correlation** (ADR-018): a pure, unwired
  client kernel binds every result in a strictly parsed response one-to-one to its
  strictly parsed request under the expected workspace. It rejects duplicate, unknown,
  omitted, wrong-resource,
  foreign-workspace, and lifecycle-incoherent results, then returns request order without
  mutating the supplied request or exposing mutable request/response aliases. Strict
  API-client tests reject future response shapes. The production coordinator remains on
  `/v1`; no dispatch or replica application changed.

## Near-term follow-ups (next things)

1. **Complete Sync v2's platform repository/runtime cutover and release gates**:
   owner-specific localStorage-to-IndexedDB promotion plus mixed-version and cross-tab
   session leadership on web; SQLite plus an explicit at-rest protection policy on
   native; transactional resource+outbox writes; durable `/v2` envelope/set/cursor
   staging; lease/device-bound dispatch; runtime correlator invocation; atomic all-or-none
   result application and pending clear; and a user-facing recovery/import path for
   quarantined legacy `iris:state:v1` data, followed by real-browser and native
   iOS/Android device or simulator acceptance.
   The owner-bound repository/root reducer and additive generic resource transport are
   integrated, and the IndexedDB compare-and-swap primitive plus push correlator exist,
   but neither is runtime-selected. The current adapter still stores one size-limited
   per-owner SecureStore/localStorage value and the production coordinator still
   dispatches the frozen `/v1` payload. Persisting and applying the exact `/v2`
   resource set, cursor, and pending envelope belongs in the transactional runtime
   cutover. Missing promotion and web leadership, native storage and protection
   decisions, recovery import, and browser/native acceptance are explicit blockers
   before the work queue.
2. **Agent-delegated work queue**: projects and tasks with status, priority, due date, one
   accountable human-or-agent assignee, reversible writes, and the same sync resource
   envelope. Keep activity, check-in, delegation, and durable claim/run semantics
   distinct.
3. **Managed auth provider** wired for real (Clerk or Supabase) + password reset + OAuth +
   email verification — these are the managed provider's job, not `LocalAuthProvider`'s.
4. **Attachment storage** to object storage (S3/R2) with the same export guarantee;
   foundation stores attachment metadata and includes files in export, but a production
   blob store + upload flow is a follow-up.
5. **Implement rate limiting** for agent tokens (per-scope budgets, a documented window,
   and 429 semantics). No coarse limiter is currently shipped.
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
