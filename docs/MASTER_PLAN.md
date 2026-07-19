# Iris — Master Plan (start → mass-market launch → product)

> The mobile, mass-market sibling of Athena: a free notes app with an optional **$5/mo
> Obsidian-priced sync tier**, where AI agents are first-class actors. This plan is the
> single map every future session works from. It is honest about what is built, what is
> only _staged_, and what is missing — and it assigns each piece of work to the model
> tier that fits its **risk × ambiguity**, so cheaper models can carry the bulk once the
> expensive ones have set the contracts.

Read order for a new session: [`VISION.md`](VISION.md) → [`DECISIONS.md`](DECISIONS.md)
(ADRs) → this file → the relevant [`.claude/skills/`](../.claude/skills/README.md) skill.

---

## 1. Where we actually are (ground truth, verified)

**Verified locally on 2026-07-19:**

- Current worktree: API **155 tests pass / 2 skipped locally** (the real-Postgres gates run in
  CI), mobile **332 tests pass**, and the production-bundle two-tab Chromium authority test passes.
  Typecheck, lint, changed-file formatting, and isolated web/Android/iOS Metro exports pass. The
  workflow adds a dedicated browser job to frozen install, typecheck, lint, both test suites with
  PostgreSQL 16, and web export. Expo's dependency compatibility check remains red on the
  pre-existing Expo/React/TypeScript cohort; SDK alignment remains a separate release-health slice.
- Recovery Center implementation commit `a497c3a` passed exact-head CI run `29699051162`, including
  its mobile regressions plus the PostgreSQL-backed API gates. Root
  `format:check` and `build` remain known repository/CI gaps; do not describe them as green.

**Solid and shipped (server):** multi-tenant auth + workspaces with `workspace_id` on every
row + FORCE RLS; versioned Markdown notes with folders + tags; agent tokens + append-only
activity + reversible undo; full-text search; Stripe gate plumbing (fake gateway in dev);
Markdown note export. **Sync v1 + the durable Sync v2 server** include commit-serialized
per-workspace cursors, request-bound idempotency receipts, CAS on every note write, a
checksummed migration ledger, and the additive `/v2` generic resource envelope (ADRs
000–016). Device deregistration, an authenticated account-deletion endpoint, runtime RLS
tests, production Stripe-key guards, and a coarse in-memory per-IP limiter also exist.

**Built but _NOT release-wired_ (the central client fact):** the strict v3 Sync v2 root,
`stage-v2`, `apply-v2`, the ADR-018 push correlator, revision-fenced IndexedDB and SQLite
stores, lazy legacy promotion, and the platform selector all exist. Transactional authority
still defaults off behind `EXPO_PUBLIC_DURABLE_STORAGE`, and the production coordinator still
dispatches frozen `/v1` payloads. The current CAS layer single-flights authoritative recovery,
fences before reducer execution through winner publication, rejects every superseded reducer,
and preserves unreadable winners while allowing safe session departure. An owner-fenced Recovery
Center now inventories durable, memory-only, and distinct displayed roots and creates a strict
local exact-byte export on web/native without a server request; it cannot choose, restore, import,
merge, or discard a root. A default-off owner-scoped Web Lock now coordinates current-runtime
browser tabs, with read-only followers and metadata-only refresh. Cross-version promotion still
leaves the legacy copy writable; client-only code cannot prevent an already-loaded old tab from
writing it, and there is no mixed-version divergence journal, enforceable compatibility gate,
or v2 pull applier.

**Still missing for release:** deploy/infra configuration, migration-on-deploy and
observability; account-deletion mobile UX, export-first confirmation, privacy policy, local
replica erasure, and durable Stripe-cancellation reconciliation; an approved App Store/Play
billing-distribution model; production database/JWT/price validation; managed auth/password
reset/OAuth/email verification; principal/sync/agent abuse budgets; EAS configuration and store
assets. Stripe remains fake outside explicitly configured test/live credentials.

---

## 2. The one thing that gates everything

**You cannot ship to the App Store / Play Store until four blockers are closed.** They
are independent of feature count and independent of the Sync v2 machinery being clever:

| #       | Blocker                                   | Why it blocks launch                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                                          |
| ------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-1** | **Durable-authority cutover**             | SQLite/IndexedDB primitives and current-runtime web leadership exist, but authority defaults to the legacy size-limited blob. Promotion leaves that legacy copy writable to old tabs/versions; client-only code can detect but cannot prevent old-client writes. There is no mixed-version divergence journal, server compatibility fence, recovery-resolution lifecycle, or device acceptance. | `promoting-replica-repository.ts`; `select-owner-replica-repository.ts`; A3b/c                                                                                                    |
| **B-2** | **Deploy + secrets + observability**      | There is no staging/deploy path, migration-on-deploy contract, readiness signal, or error telemetry. Production can still select PGlite, accept a weak JWT value, and retain the development Stripe price id.                                                                                                                                                                                   | no Docker/Fly/Render config; no Sentry/otel; `index.ts`; `env.ts`                                                                                                                 |
| **B-3** | **Safe account erasure + privacy UX**     | The API erase route exists, but Stripe cancellation failure is swallowed before its only reconciliation identifiers are deleted. Mobile has no export-first deletion flow, privacy policy/link, or local-replica erasure.                                                                                                                                                                       | `services/account.ts`; `settings.tsx`; no `docs/PRIVACY.md`                                                                                                                       |
| **B-4** | **Store billing/distribution compliance** | Native settings opens Stripe Checkout to unlock paid cloud sync. Apple and Google generally require approved billing paths for in-app digital functionality, subject to storefront and enrolled-program exceptions. Human/legal approval must choose StoreKit/Play Billing, an eligible alternative-billing/link program, or a consumption-only model.                                          | `settings.tsx`; [Apple §3.1](https://developer.apple.com/app-store/review/guidelines/); [Google Payments](https://support.google.com/googleplay/android-developer/answer/9858738) |

Everything else in this plan is either **launch-hardening** (should land right around
launch) or **post-launch product**. Do not let the impressive Sync v2 backlog reorder these.

---

## 3. How work is assigned — the tiering rubric

Assign by **risk × ambiguity, not by size.** A 5-line change that can corrupt data is Opus;
a 500-line change that follows an existing pattern with a clear spec is Sonnet or Fable.

- **🟣 Opus** — data-integrity / tenancy / security-critical, architecturally load-bearing,
  novel or ambiguous design, legal-sensitive. "Get it wrong → corruption, tenant leak, or a
  broken launch." Opus **sets the contract** (schema, ADR, interface, test skeleton) so the
  cheaper tiers can execute against it.
- **🔵 Sonnet** — well-scoped implementation against an existing pattern or an Opus-authored
  contract; moderate risk; a clear definition of done. Most feature and hardening work.
- **🟢 Fable** — mechanical, high-volume, low-ambiguity, and **front-loadable** (do it early,
  because Fable is cheapest and its credits deplete first): tests from a written spec,
  doc/skill rewrites, boilerplate, asset wiring, small mechanical refactors, and wiring an
  already-designed-and-tested kernel behind a flag.

**Non-negotiable operating discipline for every tier (carry this from the foundation work):**

1. **De-risk the uncertain thing first** with a throwaway smoke test before committing to a
   design (e.g. the PGlite FTS spike, the tsvector/GIN check).
2. **No confidence theater.** Never write "done/fixed/safe" without evidence: tests +
   typecheck + lint green **and** a real run of the affected path. `pnpm test` is the proof.
3. **One thin, end-to-end PR per slice.** Draft PR, self-review, keep it small.
4. **Skills are part of the diff.** If you change behavior a `.claude/skills/*` describes,
   fix the skill in the same PR. Stale skills actively mislead the next session.
5. **Respect the load-bearing invariants** (see the skills): tenant scoping via
   `runTenant`, the `recordVersionAndActivity` choke point, receipt/CAS/cursor rules. When
   in doubt, read `tenant-isolation`, `sync-protocol`, `notes-and-versioning` first.

---

## 4. The plan, phase by phase

Each item: **owner tier · dependency · definition of done (how to verify).**

### Phase A — Launch blockers (must close before an app-store build)

- **A1 · 🟣 Opus · Native transactional replica store. ✅ SHIPPED (ADR-020).**
  `ExpoSqliteTransactionalReplicaStore` satisfies the exact `TransactionalReplicaStore`
  CAS contract, tested against real SQLite via `node:sqlite` (create/read/revision,
  conflict-no-overwrite, owner isolation, repository fencing, corrupt-row rejection,
  exclusive-lock primitive). The platform selector can choose it behind the opt-in flag.
  **Remaining for B-1:** safe promotion/default-on plus real-device force-quit acceptance.
- **A2 · 🟣 Opus · Web cross-tab leadership. ✅ SHIPPED DEFAULT-OFF (ADR-022).** With
  `EXPO_PUBLIC_DURABLE_STORAGE` explicitly enabled, one owner-scoped Web Lock grants current-runtime
  commit/sync authority; followers are visibly read-only, reread durable state after metadata-only
  BroadcastChannel notices, and cannot acquire operation leases. A takeover rereads and validates
  the owner root before becoming leader. Missing IndexedDB, Web Locks, or BroadcastChannel keeps
  the exact legacy adapter rather than creating multiple transactional authorities. A production
  Expo bundle now runs a two-tab Playwright gate covering one leader, follower write/network
  rejection, exact channel payloads, durable pending work through leader transfer, and reacquisition.
  The flag remains off: this coordinates current code only and cannot fence an already-loaded old
  legacy writer.
- **A3 · 🟣 Opus · Sync v2 runtime cutover — STAGED (in progress).** The single riskiest
  change in the repo, so it is broken into fenced steps, each shipped tested:
  - **Step 1 — storage-backend migration primitive. ✅ SHIPPED AS A FOUNDATION ONLY.**
    `PromotingOwnerReplicaRepository` copies an existing key/value replica into the
    transactional store on first read. It retries transient failures and adopts a concurrent
    promotion winner; tests cover SQLite and a fenced fake. **Blocking audit finding:** this is
    copy-on-first-read, not a mixed-version fence. The legacy key remains writable, so an old
    tab/binary can keep syncing and strand edits after the new runtime reads only the primary.
    A new client can detect and preserve that divergence; it cannot prevent an already-loaded
    old client from writing. Production cutover therefore also needs an enforceable compatibility
    gate or explicit old-client invalidation.
  - **Step 2 — make `store.ts` fence-aware. ✅ SHIPPED; CAS + RECOVERY ORDERING CORRECTED.**
    Stale recovery is single-flight per owner and fences synchronously before another reducer can
    run. Before the authoritative read may publish anything, every exact losing v2 root—including
    notes, outbox, pending push, issue, and conflicts—is staged in memory and appended under a
    domain-separated key to a strict credential-free recovery journal. The final participant
    publishes a valid winner only after every candidate is verified. Append failure retains the
    loser and fence for same-process retry, but cannot make that candidate crash-durable while the
    selected repository is failing. Missing, corrupt, foreign, or future authority is never
    overwritten; repository-level rejection of a corrupt primary also falls through to the
    separately keyed journal. After sign-out/login, Iris reopens the newest compatible candidate
    read-only with `recovery-required` instead of creating an empty root. Session departure flushes
    pending candidates, and 401 handling still tombstones the rejected credential while throwing
    if local recovery could not also be verified. Valid superseded reducers still reject with
    `ReplicaCommitSupersededError`; `saveState` returns false. Tests cover overlapping losers,
    append failure/retry, exact outbox bytes, delayed reads, observer re-entry, session departure,
    401, sign-out/login recovery, corrupt/future authority, rejected primary reads, and pull
    pagination stopping before page N+1. A hidden owner-reset Recovery Center route is always
    discoverable from Settings. Credential-free inspection leases and projection/recovery epochs
    produce a coherent catalog of journal-verified, memory-only, and displayed-only branches with
    bounded previews; a journal read failure still surfaces an explicitly partial memory inventory.
    Local export verifies every staged branch in the journal, preserves exact journal and displayed
    bytes in a strict token-free v1 bundle, reparses before handoff, rechecks its projection/recovery
    epoch through delivery, and never commits the primary root or calls the API. Web uses a
    deferred-cleanup Blob download; native verifies a private
    cache file, retains it for slow share receivers, and attempts to purge files older than 24
    hours on a later launch/export without blocking a new export on cleanup failure. Delivery copy
    does not claim the user saved a destination. Force-quit recovery
    still needs real browser/device
    acceptance. Transactional authority remains default-off. ADR-021 records the boundary.
  - **Step 3 — platform store selection + flip production authority**, then port the
    coordinator to `/v2` and freeze the v1 path. Itself staged:
    - **Step 3a — platform-selection factory, opt-in-gated. ✅ SHIPPED.**
      `select-owner-replica-repository.ts` picks IndexedDB on web or lazily opened SQLite on
      native, wraps it in the transactional repository and legacy promoter, and stays free of
      static React Native imports. `EXPO_PUBLIC_DURABLE_STORAGE` defaults off; an unsupported
      platform silently returns the legacy adapter. Selection and lazy-open/retry tests plus web
      export pass. **Do not treat the flag as cutover-safe yet:** correct stale-CAS handling does
      not solve the two-writable-authorities window in Step 1. Enable it only in controlled test
      channels; flipping the default remains Step 3c.
    - **Step 3b — mixed-version divergence + compatibility contract. IN PROGRESS.**
      **Current-runtime leadership is shipped as A2/ADR-022:** one owner-scoped Web Lock grants
      write/sync authority, followers are read-only and refresh from metadata-only notices, and
      missing startup capabilities select legacy. The remaining mixed-version half needs a digest-only,
      crash-recoverable journal recording preparing/transactional/diverged state and checking the
      immutable legacy baseline before and after primary commits and before sync. Legacy drift must
      enter `diverged`, preserve both exact roots, reject writes/network, and surface those roots in
      the Recovery Center; it must not pretend to lock old code.
      _Remaining DoD:_ Playwright covers every promotion crash boundary and a frozen old-writer
      fixture that changes legacy after promotion and proves no later request is sent. Before
      production default-on, approve and implement an enforceable server
      storage-epoch/upgrade-required contract or another explicit old-client invalidation scheme;
      this protocol/schema decision is human-gated.
    - **Step 3c — controlled device acceptance, then default-on and Sync v2 cutover.**
      Prove recovery UX, web reload, native force-quit/reopen, A→B switching, storage exhaustion,
      SQLite at-rest policy, and unsupported-platform behavior. Only after those gates and the
      compatibility contract pass may the default flip, the coordinator move to `/v2`, and v1
      freeze.
  - _DoD:_ mobile suite green on the wired path; real-device A→B switch, lost response, and
    restart scenarios pass (device-acceptance gated).
- **A4 · 🟣 Opus (design) → 🔵 Sonnet (implement) · One-command deploy + secrets.**
  Dockerfile for `apps/api`; a `fly.toml`/`render.yaml`; migrations-run-on-deploy step
  (the ledger + advisory lock already make this safe); documented secret set
  (`JWT_SECRET`, `DATABASE_URL`, `STRIPE_*`) via the platform's secret store; a
  `/health` + `/ready` split. _DoD:_ a clean deploy to a staging project boots, migrates,
  and serves `/health`; documented in a `docs/DEPLOY.md`. _Closes B-2 (infra half)._
- **A5 · 🟣 Opus + human approval · Account deletion + export + privacy — HOLD.**
  `DELETE /v1/account` and cascade/RLS tests are shipped, but the current service swallows a
  Stripe cancellation failure and then erases the subscription id and account rows. Do not
  expose the route in mobile until a durable cancellation/reconciliation design is approved.
  Remaining: injected-gateway failure tests, old-token rejection, export-first destructive
  confirmation, `docs/PRIVACY.md` + in-app link, and local replica deletion across legacy,
  IndexedDB, and SQLite stores. _DoD:_ cancellation is either confirmed or durably recoverable,
  every server/local owner record is erased, and a deleted token receives 401. _Closes B-3._
- **A5b · 🟣 Opus + human/legal approval → 🔵 Sonnet · Store commerce model — HOLD.**
  Native settings currently opens Stripe Checkout for the paid sync entitlement. Before an
  App Store or Play build, choose and document the distribution regions and approved commerce
  path: StoreKit/Play Billing, an enrolled regional alternative-billing/link program, or a
  consumption-only companion with no prohibited purchase call-to-action. Do not infer an
  exception from the current web checkout. _DoD:_ an owner-approved decision record cites the
  then-current Apple/Google rules; entitlement purchase/restore and cross-platform mapping are
  tested; pricing/terms and reviewer notes match the chosen path. _Closes B-4._
- **A6 · 🔵 Sonnet · Observability.** Sentry (or equivalent) for API + client; keep pino
  structured logs; add minimal request/DB metrics; scrub PII. _DoD:_ a thrown error shows
  up in the dashboard from a staging deploy. _Closes B-2 (visibility half)._

### Phase B — Launch hardening (land around launch)

- **B4 · 🔵 Sonnet · Device deregistration + slot reclamation — API SHIPPED.**
  User-only list/delete endpoints, typed client methods, and billing-gate tests prove a reclaimed
  slot permits a fresh device. Remaining: settings/device UI and a visible recovery path for
  "registration is 402 but my old device is dead."
- **B5 · 🟣 Opus (policy) → 🟢 Fable (impl) · `sync_idempotency` retention/GC.** Design a
  replay-window ADR with the **double-apply analysis** (a pruned receipt's retry re-enters
  as a fresh op — decide: prune only receipts whose device `lastSeenAt` passed the window,
  or keep the row and drop the large payload). Implement the GC job; update ADR-012's
  "opId is permanent" line and the `sync-protocol` skill. _Fixes the unbounded-growth
  finding_ (`schema.ts:116-136`, `sync.ts:243-254`).
- **B6 · 🔵 Sonnet · Managed auth provider.** Wire Clerk **or** Supabase behind the existing
  `AuthProvider` seam (ADR-004); password reset + OAuth + email verification are the
  provider's job. Keep the local provider for tests/dev. _DoD:_ `AUTH_PROVIDER=clerk` boots
  and the sign-up→note→sync flow works against it in staging; local provider tests still green.
- **B7 · 🔵 Sonnet · Rate limiting + free-tier abuse caps — PARTIAL.** A coarse in-memory
  per-IP Fastify limiter with 429 tests is shipped. Remaining: separate auth/signup,
  principal/workspace, sync push/pull, and agent-token budgets; distributed storage; documented
  windows; note-count caps; and proxy-safe client identity. `TRUST_PROXY=true` currently trusts
  the entire forwarded chain and needs a deployment-specific threat model.
- **B8 · 🔵 Sonnet · Battery/network sync scheduling.** Replace the fixed 8 s poll: debounce
  editor-triggered sync (~1–2 s after last keystroke), exponential backoff + jitter on
  offline/429/5xx, `AppState`/visibility pause, `registerDevice` once per session not per
  cycle. _Fixes the mass-market-unfit finding_ (`app/_layout.tsx:23-27`, `coordinator.ts`).
- **B9 · 🔵 Sonnet · Head-of-line sync fix + tombstone compaction.** Skip an
  oversized/invalid outbox mutation with a per-note (non-terminal) issue so one bad note
  can't halt workspace-wide sync (`coordinator.ts:98-148`); drop acknowledged remote
  tombstones older than the undo window to end monotonic replica growth.
- **B10 · 🔵 Sonnet · Approved commerce implementation after A5b.** Keep live Stripe for
  eligible web/portal flows, webhook signature verification, customer portal, and plan changes;
  implement the owner-approved StoreKit/Play/alternative/consumption-only path for native
  distribution. Document the deviceId honor-system limitation (server integrity is fine; plan
  enforcement is soft). _DoD:_ staging proves purchase/restore→entitlement→gate-lifts for every
  supported channel without exposing a disallowed payment call-to-action.
- **B11 · 🟢 Fable · EAS + store assets.** `eas.json` (build profiles + OTA channels); icon,
  splash, permission strings, and store metadata in `app.json`. _DoD:_ `eas build` config
  validates; a preview build is produced (needs the user's Apple/Google accounts — flag it).
- **B12 · 🟢 Fable · Mechanical hardening batch — PARTIAL.** Failing sync errors now carry
  `operationId`. Remaining: add `expo-crypto` and delete the `Math.random` UUID/deviceId
  fallbacks (`manager.ts`, `store.ts`), then stabilize hot `useObs` selectors to avoid
  render-time resubscription churn (`hooks.ts`).

### Phase C — Product (post-launch; the Athena-parity graph, from VISION)

One connected, local-first, owner-isolated data model — **not four mini-apps.** Each domain
must inherit: local-first writes, attributed actors, reversible history, bounded permissions,
portable export. All ride the **generic sync resource envelope** already built in ADR-016
(that is why it exists).

- **C1 · 🟣 Opus (model + ADR) → 🔵 Sonnet (build) · Work graph.** Projects & tasks as new
  resource sets on the `/v2` envelope: status, priority, due date, one accountable
  human-or-agent assignee, reversible writes. Requires receipt-version-2 (ADR-016 says so).
- **C2 · 🔵 Sonnet · Attachments.** Object storage (S3/R2) with the same export guarantee;
  metadata already contemplated. Upload flow + signed URLs.
- **C3 · 🟣 Opus · Knowledge graph.** Spaces, hierarchical pages, `[[backlinks]]`,
  Obsidian/Notion import via a versioned dry-run/manifest pipeline.
- **C4 · 🟣 Opus · Agent control plane.** Durable run state, claim/lease, approvals,
  cancel/resume, bounded context packets, outputs, lineage — activity is _evidence_, never
  allowed to masquerade as liveness (VISION's rule).

### Continuous — docs & skills accuracy (mostly 🟢 Fable, from a spec)

- **D1 · 🔵 Sonnet · Rewrite `sync-protocol` skill. ✅ SHIPPED.** The playbook now matches
  ADR-015 explicit resurrection and the ADR-016 `/v2` resource envelope/cursor/replay rules.
- **D2 · 🟢 Fable · Skill drift sweep. ✅ SHIPPED AND MAINTAINED.** `client-architecture` now
  describes exact durability, stale-CAS recovery journaling, read-only recovery, and the
  local inspection/export lease plus platform handoff lifecycle; `sync-protocol` records the
  opt-in runtime selector and fail-closed recovery bundle; ADR-005
  records Iris-owned repository adapters rather than unused Legend-State persistence plugins.
  Continue grooming ROADMAP as items land.

---

## 5. Next five slices (ordered by dependency and release risk)

Do not enable transactional authority or wire Sync v2 merely because the primitives exist.
Each slice must leave a rollback point and prove the exact transition it claims.

1. **Mixed-version divergence journal + compatibility contract.** Current-runtime cross-tab
   leadership is shipped under the default-off flag. Add a digest-only, crash-recoverable journal
   and fail-closed legacy-drift detection around promotion and primary commits. A frozen old-writer browser
   fixture must preserve both roots and prove no later request is sent. Because client-only code
   cannot stop that old writer, approve an enforceable server storage epoch/upgrade response or
   another explicit invalidation mechanism before production cutover.
2. **Transactional authority acceptance + recovery UX.** Enable the flag only in test channels
   while retaining the v1 coordinator. Integrate diverged/quarantined roots into the Recovery
   Center and add choose/restore/import/discard handling, then prove web reload, native force-quit/reopen, A→B switching,
   storage exhaustion, SQLite at-rest policy, and unsupported-platform fallback. Only after the
   compatibility contract and these gates pass may the default flip.
3. **Sync v2 runtime cutover.** Add the missing pull-v2 applier, bind the v3 root through
   `SyncPort`, stage/dispatch/apply the exact durable envelope, restart safely after every
   boundary, and freeze v1 only after mixed-version replay evidence.
4. **Launch operations in parallel.** Build staging deploy + migration/readiness +
   observability; complete device/account settings UX; harden production env and abuse budgets;
   resolve the human-approved store commerce model; add EAS/store assets; and run the
   install→offline note→web sync→agent write/feed/undo→export→$5-sync acceptance path from
   `VISION.md`.
5. **Mass-market operating hardening.** Replace fixed polling with lifecycle-aware backoff,
   close device reclamation and account-erasure UX, add principal-level abuse budgets, and prove
   the browser/native/security acceptance matrix before store submission.

**Human-gated parallel release tracks:** redesign A5 so Stripe cancellation failure leaves a
durable reconciliation record before any account identifiers are erased, and decide A5b's
App Store/Play commerce model against the then-current regional policies. Money/legal and
irreversible deletion behavior requires explicit human approval before implementation or launch.

Phase C begins only after the launch flow is coherent and observable in staging.

---

## 6. Review findings ledger (evidence, so nothing gets lost)

Live-state adversarial review completed 2026-07-18 at `6a443ad`, then rechecked against
the current CAS diff. Closed findings stay visible so regressions do not re-enter the plan.

| Sev         | State       | Finding                                                                                             | Evidence                            | Next          |
| ----------- | ----------- | --------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------- |
| **blocker** | open        | Client-only promotion cannot stop an already-loaded old legacy writer                               | `promoting-replica-repository.ts`   | A3b           |
| high        | human-gated | Stripe cancel failure is swallowed before account identifiers are erased                            | `services/account.ts`               | A5            |
| high        | human-gated | Native Stripe Checkout lacks an approved App Store/Play commerce model                              | `settings.tsx`; store policies      | A5b/B10       |
| high        | open        | Production may select PGlite, weak JWT text, or the dev Stripe price id                             | `index.ts`, `env.ts`                | A4/B10        |
| high        | fixed here  | CAS recovery was not exact-commit, single-flight, or safe from reducer re-entry                     | `store.ts`, `store-fence.test.ts`   | keep tests    |
| high        | open        | Fixed 8 s polling lacks backoff, jitter, and lifecycle pause                                        | `app/_layout.tsx`, `coordinator.ts` | B8            |
| high        | open        | `sync_idempotency` retains full payloads forever                                                    | `schema.ts`, `sync.ts`              | B5            |
| medium      | partial     | Coarse per-IP limiter lacks principal/sync/agent budgets and proxy proof                            | `app.ts`, `rate-limit.test.ts`      | B7            |
| medium      | API only    | Device reclamation has no client settings/recovery flow                                             | `devices.ts`, `settings.tsx`        | B4            |
| medium      | partial     | Recovery inventory + local export ship; choose/restore/import/discard is open                       | `recovery.tsx`; ADR-021             | A3b/c         |
| medium      | partial     | CI has a real two-tab browser gate; format, root-build, coverage, security, and native gates remain | `.github/workflows/ci.yml`          | CI/acceptance |
| low         | open        | `Math.random` remains a UUID/device-id fallback                                                     | `manager.ts`, `store.ts`            | B12           |

**Verification debt:** real PostgreSQL tests run only in CI; most IndexedDB contract tests use
`fake-indexeddb`; SQLite tests use Node SQLite. A production-bundle, two-tab Chromium test now
proves current-runtime leadership and transfer, but frozen-old-writer divergence and iOS/Android
force-quit/reopen evidence do not exist. Treat that remainder as release debt, not a passing footnote.

---

## 7. What Iris is _not_ doing (guardrails, from VISION/ROADMAP)

Real-time multi-human co-editing, teams/roles/org admin, a block editor, AI inference _inside_
Iris, plugins/marketplace, desktop-native, enterprise feature-parity. Iris compresses one
operator's knowledge + execution + agent supervision into one attention-efficient mobile
surface. Every new capability is a view over the one owner-isolated data model.
