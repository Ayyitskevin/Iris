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

**Green, today** (`pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @iris/mobile export:web`):

- API: **111 tests pass / 2 skipped** (the 2 skips are the real-Postgres concurrency gate,
  which runs in CI against a Postgres 16 service). Mobile: **222 tests pass**. Typecheck +
  lint clean. Web bundle builds. CI (`.github/workflows/ci.yml`) gates all of it on every PR.

**Solid and shipped (server):** multi-tenant auth + workspaces with `workspace_id` on every
row + FORCE RLS; versioned Markdown notes with folders + tags; agent tokens + append-only
activity + reversible undo; full-text search; Stripe **gate logic** (fake gateway);
Markdown export. **Sync v1 + the durable Sync v2 _server_** are done and rigorous:
commit-serialized per-workspace cursors (DB trigger, proven on real Postgres),
request-bound idempotency receipts, CAS on every note write, a checksummed migration
ledger, the additive `/v2` generic resource envelope. (ADRs 000–016.)

**Built but _NOT wired into production_ (this is the central fact):** almost the entire
**Sync v2 _client_** — the strict v3 replica root, `stage-v2`, `apply-v2`, the ADR-018
push correlator, the revision-fenced IndexedDB CAS store, the transactional owner-replica
repository — exists with ~6k lines of tests and **zero production callers**. The shipped
runtime still runs the **v1 coordinator over a single SecureStore/localStorage KV blob**.
The ADRs (016–019) say this plainly. The machinery is excellent; it is blocked on the two
storage substrates below.

**Missing entirely (verified by grep):** any deploy/infra config (no Dockerfile, no
Fly/Render/Railway), account deletion / GDPR-erase path, rate limiting, error reporting /
metrics, EAS build config (`eas.json`), and app-store assets in `app.json`. Auth is still
**local-only** (no managed provider, no password reset/OAuth/email verify). Stripe is still
**fake** (no live keys wired).

---

## 2. The one thing that gates everything

**You cannot ship to the App Store / Play Store until three blockers are closed.** They are
independent of feature count and independent of the Sync v2 machinery being clever:

| #       | Blocker                              | Why it blocks launch                                                                                                                                                                                                                                              | Evidence                                                                                                     |
| ------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **B-1** | **Native durable storage**           | On iOS/Android the entire owner replica (all notes + outbox) is one `expo-secure-store` value (~2 KB Android ceiling). Past that, **every save fails and edits live only in RAM → lost on process death.** No `expo-sqlite` dep; the IndexedDB store is web-only. | `apps/mobile/src/state/storage.ts:29-42`; `client-architecture` skill already calls this "a release blocker" |
| **B-2** | **Deploy + secrets + observability** | There is no way to run the API in production, manage `JWT_SECRET`/`STRIPE_*`/`DATABASE_URL`, apply migrations on deploy, or see errors when it breaks.                                                                                                            | grep: no Dockerfile/fly/render; no Sentry/otel; `env.ts`                                                     |
| **B-3** | **Account deletion + privacy**       | App stores + GDPR/CCPA require a user-initiated delete-my-account + data-export path, and a privacy policy. None exists.                                                                                                                                          | grep: no account-delete route                                                                                |

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
  exclusive-lock primitive). Unwired, like the IndexedDB store. **Remaining for B-1:**
  the fenced cutover that selects it + device force-quit acceptance — folded into **A3**.
- **A2 · 🟣 Opus · Web cross-tab leadership.** Before/with the IndexedDB cutover: Web Locks
  (or BroadcastChannel) leader election so one tab owns replica commits + `storage`-event
  invalidation for followers. _DoD:_ a two-tab test (real browser) shows no lost outbox
  entry; concurrency test added.
- **A3 · 🟣 Opus · Sync v2 runtime cutover.** Select the transactional root + v3 replica
  behind the migration ledger; port the coordinator from v1 to `stage-v2`/`apply-v2` + the
  correlator + `/v2` pull; migrate existing `iris:state:v1` blobs (the quarantine/recovery
  path already exists); then **freeze or delete the v1 client path** so the two kernels
  can't drift (`apply-v2` already handles a receipt-replay tombstone case v1 doesn't).
  _DoD:_ mobile suite green on the v2 coordinator; real-device A→B account switch, lost
  response, and restart scenarios pass. **Depends on A1 + A2.** This is the single riskiest
  item in the repo; it is why native storage and web leadership come first.
- **A4 · 🟣 Opus (design) → 🔵 Sonnet (implement) · One-command deploy + secrets.**
  Dockerfile for `apps/api`; a `fly.toml`/`render.yaml`; migrations-run-on-deploy step
  (the ledger + advisory lock already make this safe); documented secret set
  (`JWT_SECRET`, `DATABASE_URL`, `STRIPE_*`) via the platform's secret store; a
  `/health` + `/ready` split. _DoD:_ a clean deploy to a staging project boots, migrates,
  and serves `/health`; documented in a `docs/DEPLOY.md`. _Closes B-2 (infra half)._
- **A5 · 🟣 Opus · Account deletion + export + privacy.** `DELETE /v1/account` (or
  `/v1/workspaces/:id`) that cascades every tenant table, cancels the Stripe subscription,
  and is irreversible + confirmed; ensure export (already built) is offered first; add a
  `docs/PRIVACY.md` + in-app links. _DoD:_ a test proves a deleted workspace leaves zero
  rows across all tenant tables and revokes the session; Stripe cancel path exercised with
  the fake gateway. _Closes B-3._
- **A6 · 🔵 Sonnet · Observability.** Sentry (or equivalent) for API + client; keep pino
  structured logs; add minimal request/DB metrics; scrub PII. _DoD:_ a thrown error shows
  up in the dashboard from a staging deploy. _Closes B-2 (visibility half)._

### Phase B — Launch hardening (land around launch)

- **B4 · 🔵 Sonnet · Device deregistration + slot reclamation.** `DELETE /v1/devices/:id`
  (user-only) and/or `lastSeenAt`-based eviction on registration, plus a client recovery
  flow for "registration 402s but my old device is dead." _Fixes the review's high-severity
  free-user-locked-out finding_ (`billing.ts:36-42`, `devices.ts:68-75`). _DoD:_ billing-gate
  test proves a reclaimed slot lets a fresh replica register.
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
- **B7 · 🔵 Sonnet · Rate limiting + free-tier abuse caps.** Per-principal limits on auth,
  `/v1|/v2/sync/push` + `changes`, and agent-token calls (429 semantics); signup throttle;
  per-workspace note-count cap; keep the 256 KiB body cap. Note: **every pull is also a
  write** (`lastSeenAt` touch) so unthrottled clients hammer the workspace lock. _Closes the
  "no throttling" launch risk._
- **B8 · 🔵 Sonnet · Battery/network sync scheduling.** Replace the fixed 8 s poll: debounce
  editor-triggered sync (~1–2 s after last keystroke), exponential backoff + jitter on
  offline/429/5xx, `AppState`/visibility pause, `registerDevice` once per session not per
  cycle. _Fixes the mass-market-unfit finding_ (`app/_layout.tsx:23-27`, `coordinator.ts`).
- **B9 · 🔵 Sonnet · Head-of-line sync fix + tombstone compaction.** Skip an
  oversized/invalid outbox mutation with a per-note (non-terminal) issue so one bad note
  can't halt workspace-wide sync (`coordinator.ts:98-148`); drop acknowledged remote
  tombstones older than the undo window to end monotonic replica growth.
- **B10 · 🔵 Sonnet · Live Stripe.** Real keys + webhook signature verification + customer
  portal + plan changes; document the deviceId honor-system limitation of the gate (it is
  spoofable — server integrity is fine, plan enforcement is soft). _DoD:_ test-mode
  end-to-end subscribe→gate-lifts flow against real Stripe test keys in staging.
- **B11 · 🟢 Fable · EAS + store assets.** `eas.json` (build profiles + OTA channels); icon,
  splash, permission strings, and store metadata in `app.json`. _DoD:_ `eas build` config
  validates; a preview build is produced (needs the user's Apple/Google accounts — flag it).
- **B12 · 🟢 Fable · Mechanical hardening batch.** (a) Attach the failing `operationId` to
  `invalid_sync_base_version` / `invalid_sync_resurrection` errors (`errors.ts`); (b) add
  `expo-crypto` and delete the `Math.random` UUID/deviceId fallbacks (`manager.ts:24-43`,
  `store.ts:163-167`); (c) stabilize `useObs` so hot screens stop re-subscribing every
  render (`hooks.ts:10-17`). Each is a tiny, well-specified, individually-testable change.

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

- **D1 · 🔵 Sonnet · Rewrite `sync-protocol` skill.** It currently teaches the **pre-ADR-015**
  "upsert resurrects a tombstone" behavior — **dangerous**; shipped code conflicts any upsert
  against a tombstone and requires an explicit `resurrect`. Replace the playbook snippet +
  line-148 gotcha; add `applyResurrect`/`invalid_sync_resurrection` and the `/v2` envelope,
  cursor namespace, and cross-route replay. (Sonnet because it must be correct about ADR-015/016.)
- **D2 · 🟢 Fable · Skill drift sweep.** `client-architecture` "saveState()" line (now
  test-only; production uses the durable queue); ADR-005's persistence-plugin table (Iris
  hand-rolls persistence, uses no MMKV/AsyncStorage plugin). Groom ROADMAP as items land.

---

## 5. First three PRs (concrete starting sequence)

Because A1–A3 are a dependency chain and Opus-heavy, and Fable/Sonnet can run in parallel:

1. **🟣 Opus — A1 native SQLite replica store** (unblocks the whole cutover). _In parallel:_
   **🔵 Sonnet — B4 device deregistration** (self-contained, closes a real user-lockout bug)
   and **🟢 Fable — D1/D2 skill-drift + B12a operationId** (mechanical, high value, cheap).
2. **🟣 Opus — A2 web cross-tab leadership** + **🔵 Sonnet — A6 observability** +
   **🟢 Fable — B12b/c crypto + useObs**.
3. **🟣 Opus — A3 Sync v2 cutover** (the big one; depends on 1&2) + **🔵 Sonnet — A4 deploy**.

Then Phase A5 (account deletion) and the rest of Phase B, then Phase C after a real launch.

---

## 6. Review findings ledger (evidence, so nothing gets lost)

From the adversarial review of the Sync v2 era (server + client agents completed; the other
six areas are **still to be reviewed** — a follow-up task for an Opus/Sonnet session):

| Sev         | Finding                                                                      | Where                                  | Mapped to        |
| ----------- | ---------------------------------------------------------------------------- | -------------------------------------- | ---------------- |
| **blocker** | Native replica can't exceed ~2 KB SecureStore value → RAM-only, lost on quit | `storage.ts:29-42`                     | A1               |
| high        | Web multi-tab last-writer-wins erases the other tab's outbox                 | `replica-repository.ts:46,68-79`       | A2               |
| high        | 8 s poll, no backoff, sync-per-keystroke → battery/network unfit             | `app/_layout.tsx:23-27`                | B8               |
| high        | `sync_idempotency` grows forever, full note payload per receipt, no GC       | `schema.ts:116-136`, `sync.ts:243-254` | B5               |
| high        | No device deregistration → free user who loses replica is 402-locked forever | `billing.ts:36-42`, `devices.ts:68-75` | B4               |
| medium      | One bad outbox mutation halts all push+pull (head-of-line)                   | `coordinator.ts:98-148`                | B9               |
| medium      | Remote tombstones stored forever; whole-replica rewrite per edit             | `coordinator.ts:344-351`               | B9               |
| low         | `/v1` push has no response byte budget (v1/v2 divergence)                    | `sync.ts:417-449`                      | (B, port v2 cap) |
| low         | Batch-abort 400s omit the failing `operationId`                              | `sync.ts:269-274`                      | B12a             |
| low         | Device gate is honor-system (spoofable `deviceId`)                           | `devices.ts:94-100`                    | B10 (document)   |
| low         | `Math.random` UUID fallback risks receipt/id collision on old Hermes         | `manager.ts:24-43`                     | B12b             |
| **doc**     | `sync-protocol` skill teaches pre-ADR-015 upsert-resurrect (dangerous)       | skill L79-82,148                       | D1               |

**Still-to-review (open task):** migration-ledger robustness, versioning/undo edge cases,
auth/billing/agents launch-readiness deep pass, CI/testing gaps (no HTTP e2e; PGlite-WASM
flake risk), full docs/skills drift, and a fresh adversarial launch pass. Re-run the review
workflow (or targeted reads) on an Opus/Sonnet budget.

---

## 7. What Iris is _not_ doing (guardrails, from VISION/ROADMAP)

Real-time multi-human co-editing, teams/roles/org admin, a block editor, AI inference _inside_
Iris, plugins/marketplace, desktop-native, enterprise feature-parity. Iris compresses one
operator's knowledge + execution + agent supervision into one attention-efficient mobile
surface. Every new capability is a view over the one owner-isolated data model.
