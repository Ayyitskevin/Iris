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
- **Phase 2.9 — transactional Sync v2 owner-root kernel** (ADR-019): a strict, unwired
  version-3 document stores the exact `notes-v1` set, workspace cursor, resource
  projections, one coalesced local draft per resource, full pending request, durable
  issue, and retained conflicts behind the revision-fenced repository. Pure staging
  preserves the exact bounded envelope before dispatch; pure application requires that
  same durable envelope plus checked workspace/device context, validates every result
  through ADR-018, then returns one all-or-none root with exact acknowledgement,
  newer-edit rebasing (including replay-safe retention of a newer delete), or both sides
  of a conflict. No production storage selection, network dispatch, or `/v2` pull
  changed.

- **Phase 2.10 — durability cutover staging** (ADR-020 + A3): native SQLite now
  satisfies the transactional CAS contract; a platform selector can choose IndexedDB or
  lazy SQLite behind `EXPO_PUBLIC_DURABLE_STORAGE`; and a promoter can copy legacy bytes
  into the transactional store. The flag defaults off. Promotion is not cutover-safe yet
  because old tabs/versions can keep writing the untouched legacy key while new clients
  read only the primary.
- **Phase 2.11 — stale-CAS semantic correction + local recovery journal**: recovery is
  single-flight per owner and synchronously fenced before another reducer can run. Every exact
  losing root (including its outbox) is staged before the authoritative read and appended to a
  strict credential-free recovery journal. The final barrier publishes a valid winner only after
  every participant is preserved; a failed append retains the loser for same-process retry but is
  not crash-durable while the selected repository is failing. Missing, corrupt, foreign, or future
  authority remains untouched—including corrupt records rejected at the transactional adapter
  boundary—and the newest compatible candidate reopens read-only as `recovery-required` rather
  than creating an empty root. Session departure verifies
  pending candidates; rejected credentials are still tombstoned and surface any recovery failure.
  Pull pagination stops on a lost commit. Tests cover overlapping losers, append failure, delayed
  reads, observer re-entry, gated departure, 401, sign-out/login recovery, rejected primary reads,
  and invalid authority. An owner-fenced Recovery Center now inventories every journal, memory,
  and distinct displayed branch it can verify, exposes a clearly partial memory inventory when the
  journal is unreadable, and creates a strict token-free local bundle without saving the primary
  root or calling the API. Exact displayed bytes are embedded when no byte-identical journal root
  exists. Web requests a deferred-cleanup Blob download; native verifies a private cache file,
  retains it across share handoff, and later attempts to purge expired files without blocking a
  new export on cleanup failure. Choose/restore/import/discard
  and force-quit browser/device acceptance remain open.
- **Phase 2.12 — current-runtime web authority, default-off** (ADR-022): when the durable
  flag is explicitly enabled, one owner-scoped Web Lock grants commit/sync authority. Other tabs
  are visibly read-only, hold no operation leases, perform no sync requests, and refresh by
  rereading the repository after an exact metadata-only BroadcastChannel notice. Takeover rereads
  before authority is published; owner switches release A before acquiring B. Missing IndexedDB,
  Web Locks, or BroadcastChannel selects the exact legacy adapter. A production-bundle two-tab
  Chromium test covers leader/follower behavior, transfer with pending work, channel privacy, and
  reacquisition. ADR-023 now supplies detection and exact preservation for an already-loaded old
  legacy writer; the flag remains off pending enforceable compatibility and recovery acceptance.
- **Phase 2.12a — mixed-version divergence containment, default-off** (ADR-023): the promoter now
  writes a strict digest-only preparing/transactional/diverged journal directly to the raw
  transactional backend. It captures the immutable valid legacy baseline, rechecks both exact
  roots before/after primary commits and before each authenticated fetch, preserves diverged
  branches and optimistic candidates in the token-free recovery journal, then fences writes,
  leases, and network; active projections enter visible recovery mode. Illegal/corrupt/future
  control state stays untouched. Unit tests cover semantic journal parsing, crash boundaries,
  shared-repository recovery append races, crash-durable reason provenance, later legacy writes,
  real-SQLite promotion, and
  zero-request fencing. Completed transactional history is bounded by a 64-entry threshold and a
  CAS-safe checkpoint; preparing/diverged evidence is never compacted. Production-bundle Chromium adds a frozen
  same-origin old writer with no current authority code and proves exact branch preservation,
  digest-only control metadata, disabled UI, and no post-drift request. This contains ambiguity;
  it cannot exclude old code. The flag remains off pending a human-approved enforceable server
  compatibility contract, recovery resolution, and browser/native lifecycle acceptance. Initial
  native reload recovery presentation is explicitly part of that remaining acceptance gate.
- **Phase 2.13 — server launch hardening, partial**: user-only device deregistration and
  account deletion endpoints, runtime non-superuser RLS tests, production Stripe-key
  guards, and a coarse per-IP rate limiter are shipped. Client device/deletion UX,
  durable Stripe-cancellation reconciliation, production database/JWT/price validation,
  proxy/principal abuse budgets, privacy, and local-replica erasure remain open.

## Near-term follow-ups (ordered)

1. **Enforceable old-client compatibility gate (human-gated).** ADR-023's default-off client
   journal and frozen-old-writer browser gate detect, preserve, and stop local work before another
   request, but client-only code cannot prevent the old write. Approve and implement a server
   storage epoch, upgrade-required response, or explicit old-client invalidation before cutover.
2. **Controlled transactional-authority acceptance + recovery resolution UX.** Keep `/v1`
   networking while integrating diverged and quarantined roots into the shipped local Recovery
   Center and adding choose-winner, restore/import, and discard controls, then test
   IndexedDB reload, native SQLite force-quit/reopen, A→B switching, unsupported-platform
   fallback, and the explicit at-rest policy. Flip the default only after the compatibility
   contract and these gates pass.
3. **Sync v2 runtime cutover.** Build the missing pull applier and bind the v3 owner root,
   exact durable envelope, lease/device dispatch, correlator, restart boundaries, and v1
   retirement through the production `SyncPort`.
4. **Launch operations.** Add staging deploy, migrations-on-deploy, `/ready`, secret
   documentation, production DB/JWT/Stripe-price validation, PII-scrubbed observability, and
   the remaining format/root-build/coverage/native/security CI gates.
5. **Safe account erasure + privacy (human-gated).** Make Stripe cancellation confirmed or
   durably reconcilable before deleting identifiers; prove old-token 401; add export-first
   mobile confirmation, privacy policy/link, and legacy/IndexedDB/SQLite replica erasure.
6. **Store commerce decision (human/legal-gated).** Choose StoreKit/Play Billing, an enrolled
   regional alternative path, or a consumption-only model before exposing paid sync in native
   builds; then prove purchase/restore and entitlement mapping for every supported channel.
7. **Managed auth provider.** Wire Clerk or Supabase, password reset, OAuth, and email
   verification behind the existing seam.
8. **Mass-market hardening.** Replace fixed polling with lifecycle-aware debounce/backoff;
   add principal/sync/agent abuse budgets and proxy proof; then finish Stripe portal,
   proration/dunning/tax.
9. **EAS + store submission.** Add build profiles, OTA channels, assets, permission copy, and
   a preview build after the owner supplies Apple/Google account access and approves item 6.
10. **Attachments.** Add object storage, upload/signed-URL flows, export inclusion, and native
    sharing. Current export contains Markdown notes and a manifest only.

The agent-delegated work graph and other product-horizon features wait until the release
acceptance path is coherent and observable.

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
