# Sync + account-deletion recovery paths

Operator/user recovery surface for failure states introduced or hardened by the
sync-resilience milestone (`grok/iris-sync-resilience`). Complements ADR-011/012
and the `sync-protocol` skill.

Diagnostics are structured and privacy-safe: they never include session tokens,
note bodies, passwords, or raw account emails.

## Failure states and recovery

| State | How it appears | Recovery |
| --- | --- | --- |
| **Lost push response** | Client still has durable `pendingPush`; server may already hold a receipt. | Automatic: next cycle retries the **exact** pending snapshot. Server replays the frozen receipt (no double-apply). No operator action unless retries exhaust transport backoff. |
| **Duplicate / delayed / reordered push** | Exact retry → same applied/conflict batch. Payload or actor/device change for same `opId` → HTTP **409** `idempotency_key_reused`. Whole batch rolls back. | Visible durable `syncIssue` with `recoveryKind: rekey`. User/operator must rekey the colliding op (edit + restage) — never silently rebind. |
| **Incomplete receipt** (`outcome` null or malformed) | HTTP **409** `sync_receipt_incomplete` with `operationId`. Client parks a terminal hold (`recoveryKind: retry`). | **Fail closed.** Do not rekey (risk of double-apply if side effects landed). Inspect server `sync_idempotency` for that workspace+opId; if the note head matches the intended mutation, manually clear the incomplete receipt only after confirming no partial note write; if note is missing, delete the incomplete claim row in a maintenance window so a controlled retry can claim cleanly. Prefer support playbook over client auto-heal. |
| **Unsupported receipt version** | Same as incomplete: **409** `sync_receipt_incomplete`. | Upgrade server/clients to a shared receipt version; do not fingerprint unknown envelopes as v1. |
| **Malformed successful sync response** | Client `invalid_sync_response` hold. | Retry after service health; hold blocks automatic network until manual recovery action. |
| **Invalid / foreign cursor** | **400** `invalid_sync_cursor` → hold with `reset-cursor`. | Manual recovery resets cursor and restages; never accept another workspace’s cursor. |
| **Account deletion unconfirmed** | **400** `account_deletion_unconfirmed`. | No server mutation. User must echo their own email. Diagnostic event `account_deletion_unconfirmed` (ids only). |
| **Account deletion confirmed** | **200** `{ deleted: true }`. Workspace + owner cascade-erased. Old JWT → **401**. | Irreversible on server. Client must call `eraseLocalOwnerAfterConfirmedAccountDeletion({ serverDeleted: true, ownerKey, userId, workspaceId })` so pending local drafts cannot re-upload. Emits `account_deletion_completed` (workspaceId, userId, stripe suffix only). |
| **Account deletion during pending sync** | Delete acquires the workspace sync lock (same row as push). Concurrent push either finishes first (then cascade wipes) or waits and then gets **401** after erase. | Local: after confirmed delete + local erase, no pendingPush remains. If erase fails, status is `error` and durable bytes are not claimed wiped — use Recovery Center export, then retry erase. |
| **Stripe cancel failure during delete** | Erasure still proceeds (GDPR). Diagnostic `account_deletion_billing_cancel_failed` with `stripeSubscriptionIdSuffix` (last 4). | Human-gated durable reconciliation (plan A5). Operator correlates suffix + workspaceId out of band; do not re-create the Iris account to “fix” billing. |
| **Partial local erase failure** | `StatePersistenceError`; projection `error`. | Fail closed. Do not invent an empty live session. Retry erase; if storage is broken, export via Recovery Center if any root remains, then wipe device storage for that owner key. |
| **Durable-storage erase (IndexedDB / SQLite)** | Same entry point as KV: `eraseLocalOwnerAfterConfirmedAccountDeletion`. Primary + recovery-journal owner keys are removed via `TransactionalReplicaStore.erase` / repository `erase`. | Verify with store read after erase. Absent keys are success (idempotent). Fenced stale writers may still erase — confirmed deletion does not require rehydrate first. |
| **Ambiguous replica authority** | Existing recovery-required / divergence holds (ADR-021/023). | Recovery Center inventory + export only; choose/restore remains gated. Never auto-pick a winner. |

## Client hold behavior

While a durable `syncIssue` exists, the coordinator performs **no** register/push/pull.
Incomplete receipts use `recoveryKind: retry` (preserve exact pending request) rather than
`rekey`, because minting a new `opId` could double-apply if the original mutation partially
landed.

## Privacy rules for diagnostics

Allowed: workspace id, user id, operation id, stripe subscription id **suffix** (last 4),
event name, boolean flags.

Forbidden: bearer tokens, passwords, note titles/bodies, full email addresses, raw Stripe
secrets, recovery bundle contents.

## Authority survival matrix (Prompt 2)

Deterministic interleavings (no fixed sleeps as correctness). Observable signals are
durable `pendingPush` / replica notes / lease generation / terminal `syncIssue` / empty
storage after erase.

| # | Interleaving | Invariant | Recovery |
| --- | --- | --- | --- |
| 1 | Leader crashes after durable `pendingPush`, before network receipt | Exact `opId` + payload retained; restart replays same batch | Automatic coordinator retry of exact pending; server receipt prevents double-apply |
| 2 | Leader crashes after server apply, before local reconcile persist | Local `pendingPush` remains until reconcile commits | Retry same pending; server returns frozen receipt outcome |
| 3 | Follower takes over after lease expiry | Old generation returns `stale`; new generation may push exact pending once | Owner root is generation-fenced; no transfer of in-flight A work to wrong generation as “done” |
| 4 | Stale leader wakes after takeover | Writes/pushes for old generation fail closed | Drop stale process; continue under current lease only |
| 5 | Account deletion races pending local work | Server cascade + `eraseLocalOwnerAfterConfirmedAccountDeletion` clear primary + journal; cold load cannot rehydrate private pending | Fail closed if erase cannot verify; export Recovery Center only if roots remain |
| 6 | Terminal stored incomplete receipt | Client parks `sync_receipt_incomplete` with `recoveryKind: retry`; no automatic network while held | Operator playbook (incomplete receipt row above); never rekey blindly |

Commands (in-repo proofs):

```bash
pnpm --filter @iris/mobile exec vitest run \
  src/sync/authority-survival-matrix.test.ts \
  src/sync/adversarial-sync-integrity.test.ts \
  src/state/account-deletion-local.test.ts
pnpm --filter @iris/api exec vitest run test/adversarial-sync-integrity.test.ts
```

Residual limitations: physical multi-device force-quit, human-gated Stripe cancel
reconciliation row, and Recovery Center choose/restore remain open (not part of this matrix).

## Related tests

- `apps/api/test/adversarial-sync-integrity.test.ts` — server wire + deletion proofs
- `apps/mobile/src/sync/adversarial-sync-integrity.test.ts` — coordinator fault injection
- `apps/mobile/src/sync/authority-survival-matrix.test.ts` — Prompt 2 crash/takeover/fence matrix
- `apps/mobile/src/state/account-deletion-local.test.ts` — local erase fence + no rehydrate
