---
name: sync-protocol
description: Open when touching the local-first change-feed — cursor pulls, base_version pushes, conflict surfacing, the outbox, or the client sync() loop (ADR-005).
---

## When to use

- Adding/changing anything in `GET /v1/sync/changes` (pull) or `POST /v1/sync/push` (push).
- A note edit is lost, duplicated, or resurrected after sync; a delete "comes back"; a conflict is silently dropped instead of surfaced.
- The pull cursor skips rows, re-sends the same rows forever, or never advances.
- The client shows stale data, spins on `status: 'syncing'`, or an offline edit never lands.
- Wiring a new field into the sync payload (it must be added in `packages/shared/src/schemas.ts` first — server and client both infer from there).
- Reasoning about the billing gate as it applies to sync (register-device 402 → `syncGated`).

## Mental model

Sync is **version-based optimistic concurrency with surfacing**, not CRDTs (ADR-005 is explicit: whole-document Markdown, single operator, so no merge). Two independent halves:

1. **Pull** — `syncChanges` returns every note (including tombstones) with `(updated_at, id)` strictly greater than an opaque cursor, ordered by that same pair, so the cursor is a monotonic high-water mark the client stores and replays.
2. **Push** — the client sends a batch of mutations, each stamped with the `baseVersion` it was derived from. The server applies a mutation only if `existing.version === baseVersion`; otherwise that op is a **conflict** carrying the authoritative `serverNote`. Conflicts are returned, never overwritten.

The client (`apps/mobile`) is local-first: edits mutate a Legend-State observable *synchronously* and drop a coalesced entry into a persisted **outbox**. `sync()` then registers the device (billing gate), pushes the outbox, and pulls deltas — preserving still-pending edits. The UI never waits on the network. **Conflict-surfaced ≠ conflict-resolved:** the client takes server state and flags `conflictNoteId` for the user to re-apply.

## Key files

- `apps/api/src/services/sync.ts` — the whole server protocol.
  - `syncChanges(ctx, cursor, deviceId)` — the pull; row-value `(updated_at,id) > cursor` query, `LIMIT PAGE (500)`.
  - `syncPush(ctx, deviceId, mutations)` — the push loop; dispatches each op to `applyUpsert`/`applyDelete`.
  - `encodeCursor` / `decodeCursor` — cursor is `"${updatedAt.toISOString()}|${id}"`; empty/`'genesis'` → epoch 0 + `NIL_UUID`.
  - `conflictResult(m, existing)` — builds `{opId, reason:'version_mismatch', serverNote}`.
- `packages/shared/src/schemas.ts` — the wire contract (single source of truth).
  - `SyncMutation` (`opId`, `type:'upsert'|'delete'`, `note{id,title,bodyMd,folder}`, `baseVersion`), `SyncPushRequest`, `SyncPushResponse{applied[],conflicts[]}`, `SyncConflict`, `SyncChangesResponse{changes,cursor,hasMore}`.
- `packages/shared/src/api-client.ts` — `syncChanges(since, deviceId)`, `syncPush(body)`, `registerDevice(body)`; `ApiRequestError.isPaymentRequired` / `.isConflict`.
- `apps/mobile/src/sync/manager.ts` — client engine: `createNoteLocal`/`updateNoteLocal`/`deleteNoteLocal` (optimistic), `enqueue` (outbox coalescing), `sync()` (register → push → pull).
- `apps/mobile/src/state/store.ts` — `store$` observable + `AppState` (`notes`, `outbox`, `syncCursor`, `deviceId`, `syncGated`, `conflictNoteId`); `saveState`/`loadState` persistence.
- `apps/api/src/app.ts:242-256` — routes; both gate on `requireScope` (`notes:read` for pull, `notes:write` for push).
- `apps/api/src/services/note-write.ts` — `loadNote`, `recordVersionAndActivity` (every applied mutation calls this: version snapshot + activity row).
- `apps/api/src/services/devices.ts:70` — `requireRegisteredDevice` (both endpoints call it; pulling is syncing too).
- `apps/api/test/sync.test.ts` — the executable spec: push offline create → pull → good update → stale update conflicts → re-pull sees server version.

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

Client loop (`manager.ts:sync()`):

```ts
await api.registerDevice({id: deviceId, name, platform});   // 402 → syncGated=true; RETURN (local still works)
const res = await api.syncPush({deviceId, mutations: outbox});
for (const a of res.applied)   if (a.note) store$.notes[a.note.id].set(a.note);
for (const c of res.conflicts) { store$.notes[c.serverNote.id].set(c.serverNote);   // take server state
                                 store$.conflictNoteId.set(c.serverNote.id); }       // surface, don't drop
store$.outbox.set([]);
const pending = new Set(store$.outbox.get().map(m => m.note.id));   // preserve edits made mid-sync
const changes = await api.syncChanges(store$.syncCursor.get(), deviceId);
for (const n of changes.changes) if (!pending.has(n.id)) store$.notes[n.id].set(n);
store$.syncCursor.set(changes.cursor);
```

To verify a protocol change, run the spec and add a case mirroring its shape:

```bash
pnpm --filter @iris/api test sync.test.ts
```

Follow the test's pattern: `signUp` → `POST /v1/devices` (must register first) → push with `baseVersion` → assert `applied[0].note.version` and `conflicts[0].serverNote`. Re-pull with the pre-edit cursor to prove the newer version surfaces.

To add a synced field: add it to `SyncMutation.note` and `Note` in `schemas.ts`, thread it through `applyUpsert`/`applyDelete` writes and `serializeNote`, then through `createNoteLocal`/`updateNoteLocal` in `manager.ts`. Both ends fail to compile until consistent — that's the design.

## Invariants & gotchas

- **`/v1/sync/push` returns HTTP 200, not 409.** Batch conflicts ride in the `conflicts[]` array of a 200 body. The real HTTP **409** (`ApiRequestError.isConflict`, `error.conflict`) is the *single-note* REST path only — `PATCH`/`DELETE /v1/notes/:id` via `services/notes.ts` `conflict(...)`. Don't expect a 409 status from the sync endpoint; don't put a batch into the REST endpoint.
- **Cursor is `(updated_at, id)` row-value, not a timestamp.** The `> (t::timestamptz, id::uuid)` comparison plus matching `ORDER BY asc(updatedAt), asc(id)` is what makes it stable when many rows share a millisecond. Break the pairing (order by only `updated_at`, or compare columns separately) and you drop or duplicate rows. Keep the explicit `::timestamptz`/`::uuid` casts — they stop PGlite/pg from misinferring param types.
- **`decodeCursor` splits on `lastIndexOf('|')`.** Safe only because an ISO-8601 timestamp contains no `|`. If you ever change `encodeCursor`'s delimiter or the id format, fix both together.
- **Empty page keeps the cursor.** `nextCursor = rows.length ? encode(last) : cursor` — a pull with no new rows returns the same cursor, so the client never rewinds. `hasMore = rows.length === PAGE (500)`; a full page means loop again immediately.
- **Tombstones are pulled, not filtered.** `syncChanges` selects deleted rows too, so deletes propagate. Client-side visibility filtering is `selectVisibleNotes()` in `store.ts` (`!n.deletedAt`). Never add `WHERE deleted_at IS NULL` to the change-feed.
- **Upsert resurrects a tombstone** (`deletedAt: null` on update). An edit to a note deleted elsewhere un-deletes it. Intended (edit wins over delete for the same version); know it before "fixing" it.
- **`version: 0` means client-local, unacked.** `createNoteLocal` sets 0 and pushes `baseVersion: 0`; the server insert assigns `version: 1`. A `baseVersion: 0` against an *existing* row whose version ≠ 0 is a conflict, not an insert — only a truly-absent row inserts.
- **Outbox coalesces per note id.** `enqueue` drops any prior pending mutation for the same `note.id` and appends the new one (latest local state, fresh `opId`, `baseVersion` = version at enqueue time). Keeps the outbox small; means only the final local state is pushed.
- **`opId` is the idempotency key** — client-generated so retries don't double-apply. Preserve it end-to-end; the client matches `applied`/`conflicts` back by `opId`.
- **`outbox.set([])` after push can drop a mid-sync edit.** An edit enqueued while the `await syncPush` is in flight is cleared by the unconditional reset. `sync()` is single-flighted by the `syncing` flag, and `enqueue` re-triggers `sync()`, but the window exists — suspect it when a rapid edit-during-sync goes missing. The `pending` set is recomputed *after* the clear, so it's normally empty.
- **Conflict = surfaced, not merged.** The client overwrites its note with `serverNote` and sets `conflictNoteId`; the user's local text is gone from the store and must be re-applied. That is the ADR-005 contract ("detect and surface, never silently drop") — do not add auto-merge.
- **Every applied mutation must call `recordVersionAndActivity`** (snapshot + append-only activity row) — the reversibility pillar. A new server-side sync path that writes `notes` without it breaks undo/history.
- **Both endpoints gate on `requireRegisteredDevice`**, and registration is where the multi-device billing limit bites (402, ADR-007). An unregistered/over-limit device gets `isPaymentRequired`; the client sets `syncGated` and returns — local edits still work, they just don't sync.
- **Everything runs inside `runTenant`'s single transaction**, workspace-scoped via the RLS GUC. A push batch is atomic per request; `loadNote`/writes already filter by `ctx.workspaceId`. Never reach around `ctx.db`.
