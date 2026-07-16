---
name: sync-protocol
description: Open when touching the local-first change-feed — database cursors, request receipts, base_version pushes, conflicts, durable outbox staging, or the coordinator (ADR-005/011/012).
---

## When to use

- Adding/changing anything in `GET /v1/sync/changes` (pull) or `POST /v1/sync/push` (push).
- A note edit is lost, duplicated, or resurrected after sync; a delete "comes back"; a conflict is silently dropped instead of surfaced.
- The pull cursor skips rows, re-sends the same rows forever, or never advances.
- The client shows stale data, spins on `status: 'syncing'`, or an offline edit never lands.
- Wiring a new field into the sync payload (it must be added in `packages/shared/src/schemas.ts` first — server and client both infer from there).
- Reasoning about the billing gate as it applies to sync (register-device 402 → `syncGated`).

## Mental model

Sync is **version-based optimistic concurrency with surfacing**, not CRDTs. It has two
transactionally connected halves:

1. **Pull** — `syncChanges` returns notes (including tombstones) whose `sync_seq` is
   greater than an opaque `v2:<workspace-id>:<sequence>` cursor. A per-workspace
   counter is locked before note rows, so committed sequences cannot be observed out of
   commit order or accidentally reused for another workspace.
2. **Push** — every mutation carries `baseVersion` plus a durable `opId`. The server
   permanently binds that id to workspace + actor + device + parsed payload and stores
   the applied-or-conflict outcome in the same transaction as note history/activity.

The client is local-first: edits update Legend-State synchronously and coalesce into the
outbox. Before network dispatch, the coordinator persists an exact `pendingPush`
snapshot. Lost responses and restarts retry that snapshot; reconciliation preserves and
rebases newer outbox edits. Push requests and pull pages are bounded by both row count
and serialized UTF-8 bytes, and successful responses are runtime-validated. Conflicts
retain both sides in the persisted Review inbox. A durable terminal `syncIssue` stops
all automatic network work until the user invokes its explicit recovery action.

## Key files

- `apps/api/migrations/0003_sync_v2.sql` — workspace-composite note/device identities,
  backfill, workspace counter, note sequencing triggers, request receipts, RLS, and the
  `notes_sync_idx` replacement.
- `apps/api/src/services/sync.ts` — server protocol.
  - `syncChanges` validates/upgrades the cursor and reads `sync_seq` pages.
  - `applyIdempotently` claims or replays a versioned, fingerprint-bound receipt.
  - `applyUpsert` / `applyDelete` own note version/conflict semantics.
- `packages/shared/src/schemas.ts` — the wire contract (single source of truth).
  - `SyncChangesRequest`, `SyncMutation`, the bounded same-`/v1` push ingress,
    client chunk validation, byte helpers, and validated applied/conflict responses.
- `packages/shared/src/api-client.ts` — typed sync methods plus distinct version
  conflict, idempotency-reuse, and payment-required classifiers.
- `apps/mobile/src/sync/manager.ts` — optimistic local mutations and conflict choices.
- `apps/mobile/src/sync/coordinator.ts` — lease-bound register → staged push → paged pull.
- `apps/mobile/src/sync/reconcile.ts` — pure response validation/reconciliation.
- `apps/mobile/src/state/store.ts` — owner replicas, `pendingPush`, durable
  `syncIssue`, persistence, and leases.
- `apps/api/src/app.ts` — parsed routes with `notes:read`/`notes:write` scopes.
- `apps/api/src/services/note-write.ts` — `loadNote`, `recordVersionAndActivity` (every applied mutation calls this: version snapshot + activity row).
- `apps/api/src/services/devices.ts` — user-only explicit registration plus
  `requireRegisteredDevice`; both sync endpoints reject unknown workspace-composite
  device ids without allocating state.
- `apps/api/test/sync.test.ts` + `sync-migration.test.ts` — replay/collision,
  cursor, atomic rollback, and upgrade-with-data executable specs.
- Mobile coordinator/store/reconcile tests cover lost responses, restart, newer edits,
  persistence failure, stale sessions, and conflict retention.

## Playbook

**Most common task: trace one round-trip and verify a change end-to-end.**

Server push, per mutation (`sync.ts`):

```ts
// applyUpsert
const existing = await loadNote(ctx, m.note.id);
if (!existing) {                        // created offline → adopt client id
  insert {...m.note, version: 1};       // NB: server assigns 1, client sent baseVersion 0
  recordVersionAndActivity(ctx, note, 'note.create');
  return applied;
}
if (existing.version !== m.baseVersion) return conflictResult(m, existing);  // stale
update {...m.note, version: existing.version + 1, deletedAt: null, updatedAt: now};
recordVersionAndActivity(ctx, note, 'note.update');   // deletedAt:null ⇒ upsert RESURRECTS a tombstone
```

`applyDelete` is idempotent: missing note → `applied` (no `note`); already-tombstoned → `applied` echoing the tombstone; version mismatch → conflict; else set `deletedAt`, bump version, record `note.delete`.

Client loop (`coordinator.ts`, simplified):

```ts
if (replica.pendingPush) {
  await commit((current) => current); // prove the visible snapshot is durable
}
if (!replica.pendingPush && replica.outbox.length) {
  await commit((current) => stagePendingPush(current, deviceId));
  // stagePendingPush greedily enforces both the operation cap and exact serialized
  // UTF-8 request-byte budget, then persists that immutable slice.
}
await api.registerDevice({ id: lease.deviceId, name, platform });
for (let chunk = 0; chunk < SYNC_PUSH_CHUNK_LIMIT; chunk += 1) {
  if (chunk > 0) await preparePendingPush(lease, false);
  const sent = readReplica(lease).pendingPush ?? [];
  if (!sent.length) break;
  const response = await api.syncPush({ deviceId: lease.deviceId, mutations: sent });
  await commit((current) => ({
    ...current,
    ...reconcilePush(current, sent, response, now()),
    pendingPush: null,
  }));
}
await drainChangePages(cursor, fetchPage, (page) =>
  commit((current) => applyOwnedPageWithoutOverwritingPending(current, page)),
);
```

To verify a protocol change, run the spec and add a case mirroring its shape:

```bash
pnpm --filter @iris/api exec vitest run test/sync.test.ts test/sync-migration.test.ts
pnpm --filter @iris/mobile exec vitest run src/sync src/state/store.test.ts
```

For retry changes, prove both response equality and unchanged version/activity counts.
For migration changes, seed multiple notes before 0003 and invoke the supported runner twice. For coordinator
changes, model a committed response loss and a newer edit before the exact retry.

To add a synced field: add it to `SyncMutation.note` and `Note` in `schemas.ts`, thread it through `applyUpsert`/`applyDelete` writes and `serializeNote`, then through `createNoteLocal`/`updateNoteLocal` in `manager.ts`. Both ends fail to compile until consistent — that's the design.

## Invariants & gotchas

- **Version conflicts are HTTP 200 batch results.** HTTP 409 from this endpoint now means
  `idempotency_key_reused`: the same `opId` named a different actor/device/payload.
- **Cursor is `v2:<workspace-id>:<sync_seq>`.** Never derive it from time. The
  statement trigger must lock `workspace_sync_cursors` before note-row locks; the row
  trigger assigns the next sequence. A cursor for another workspace fails. A recognized
  legacy timestamp cursor or unbound draft v2 cursor replays once; malformed/ahead
  cursors fail.
- **Migration order is load-bearing.** Add nullable → drop migration-owned triggers →
  suspend FORCE RLS transactionally → backfill → seed counters → NOT NULL/default/index
  → recreate triggers → re-enable and FORCE RLS. The checksummed ledger applies 0003
  once and revalidates its current-head artifacts on later runs; test populated 0001
  and 0001+0002 upgrades through the runner.
- **Pull is count- and byte-bounded.** The server reads one sentinel beyond its row cap,
  stops earlier when the serialized UTF-8 response budget fills, and sets `hasMore`
  from the first unreturned row. A single recognized legacy oversized note may be
  returned alone so migration remains lossless; every later page is bounded. The client
  rejects repeated cursors and caps one drain at `SYNC_CHANGE_PAGE_LIMIT` (1,000)
  unique pages.
- **Tombstones are pulled, not filtered.** `syncChanges` selects deleted rows too, so deletes propagate. Client-side visibility filtering is `selectVisibleNotes()` in `store.ts` (`!n.deletedAt`). Never add `WHERE deleted_at IS NULL` to the change-feed.
- **Upsert resurrects a tombstone** (`deletedAt: null` on update). An edit to a note deleted elsewhere un-deletes it. Intended (edit wins over delete for the same version); know it before "fixing" it.
- **`version: 0` means client-local, unacked.** `createNoteLocal` sets 0 and pushes `baseVersion: 0`; the server insert assigns `version: 1`. A `baseVersion: 0` against an _existing_ row whose version ≠ 0 is a conflict, not an insert — only a truly-absent row inserts.
- **A missing note plus nonzero `baseVersion` is invalid.** It is neither a create nor a
  representable version conflict, so the server rejects the request and the client
  leaves its durable request visible in the error state.
- **The body ceiling measures JSON wire expansion.** New Markdown bodies may contain at
  most 262,144 JSON-encoded UTF-8 content bytes, so escapes count at their transmitted
  size; PostgreSQL-incompatible NUL characters are rejected before storage.
- **Outbox and pending request are distinct.** Outbox coalesces the newest edit per note;
  `pendingPush` is an immutable, schema-validated slice of at most six operations and
  1,900,000 serialized UTF-8 request bytes until its exact response is durably
  reconciled. Never replace the pending payload with a newer outbox item; the remainder
  stays in outbox for a later bounded chunk. Reconfirm an already-visible pending batch
  through the persistence queue before dispatch; a failed earlier save may have left
  only an in-memory projection. Every client shares `POST /v1/sync/push` and its same
  finite schema beneath Fastify's distinct 2,097,152-byte ingress ceiling; there is no
  uncapped whole-outbox compatibility lane. The six-operation cap also bounds a
  worst-case applied/conflict response for currently bounded notes, including JSON
  escaping, to 1,900,000 bytes. A migrated pre-limit oversized note remains lossless
  and may occupy one conflict response beyond that modern-data budget. A cycle drains
  at most `SYNC_PUSH_CHUNK_LIMIT` (16) chunks / 96 operations, durably
  clearing each `pendingPush` before staging the next; any remainder waits for the next
  cycle.
- **`opId` is permanent.** The server stores applied/conflict outcomes under a frozen
  receipt version. A retry must preserve actor, device, parsed payload, and its versioned
  fingerprint; changing any of them is a loud 409, and unknown versions fail closed.
- **Workspace lock precedes receipt locks.** Every non-empty push locks/upserts
  `workspace_sync_cursors` before claiming any `opId`. Preserve that order so batches
  with reversed operation ids cannot deadlock.
- **Conflict = retained, not merged.** Both local mutation and server head remain in the
  owner-scoped Review inbox until an owner/op-fenced user choice.
- **Terminal protocol problems are durable holds, not retry loops.** Invalid successful
  responses, workspace mismatches, protocol violations, non-transient client errors,
  oversized/invalid local mutations, reused operation ids, and bad cursors persist a
  `syncIssue`. While it exists the coordinator performs no registration, push, or
  pull. The visible manual action deliberately rekeys, resets the cursor, restages, or
  retries; a generic retry preserves the exact pending request.
- **Every applied mutation must call `recordVersionAndActivity`** (snapshot + append-only activity row) — the reversibility pillar. A new server-side sync path that writes `notes` without it breaks undo/history.
- **The sequence trigger is not a substitute for CAS.** Reads occur before the statement
  trigger acquires the workspace lock. Sync, REST update/delete/restore, and undo all
  predicate their UPDATE on the loaded note version so a raced writer becomes a typed
  conflict instead of a duplicate-version 500.
- **Both endpoints gate on `requireRegisteredDevice`.** A signed-in user must first
  call `POST /v1/devices`, where the multi-device billing limit bites (402, ADR-007).
  The sync checks never auto-register: an unknown id gets 403. The first-party client
  performs the explicit registration step and treats its 402 as `syncGated`; local
  edits still work.
- **Everything runs inside `runTenant`'s single transaction**, workspace-scoped via the RLS GUC. A push batch is atomic per request; `loadNote`/writes already filter by `ctx.workspaceId`. Never reach around `ctx.db`.
- **Local repository durability is not done.** The owner JSON value is still
  SecureStore/localStorage. SQLite/IndexedDB and cross-tab coordination remain release
  blockers even though network retry ambiguity and terminal retry loops are closed.
