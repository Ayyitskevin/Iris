---
name: activity-and-undo
description: Open when touching the activity feed, the undo endpoint, note_versions/activity_log rows, or debugging why an action shows (or won't show) as undone.
---

## When to use

- Adding a new reversible action, or making an existing mutation show up in the feed / be undoable.
- Bug: "undone" flag is wrong, an action can't be undone, or undo restored the wrong content.
- Touching `activity_log`, `note_versions`, or the `POST /v1/activity/:id/undo` route.
- Understanding why undo produces a *new* version instead of rewinding, or why undoing a create deletes the note.
- Adding a non-note activity (e.g. token issuance) and wondering why it returns `not_undoable`.

## Mental model

The activity log is **append-only**: rows in `activity_log` are never updated or deleted. Every note mutation goes through the single choke point `recordVersionAndActivity` (`services/note-write.ts:22`), which writes an immutable `note_versions` snapshot of the note's *current* state plus one `activity_log` row describing the action. Undo is not a mutation of history — it is a *forward* action that restores the note's pre-action snapshot as a **new head version** and appends a compensating `note.undo` entry whose `undoOfId` points back at the reversed action. Because of this, "was this action undone?" is **derived at read time**: an entry is undone iff some other row names it as `undoOfId` (`services/activity.ts:26`). There is no `undone` column. Undo is operator-only (`requireUser`); agents can act but cannot undo.

## Key files

- `services/note-write.ts:22` — `recordVersionAndActivity(ctx, note, action, undoOfId=null)`. THE choke point. Snapshots `note.version` into `note_versions`, writes `activity_log` row with `resultingVersion = note.version`, `noteVersionId`, `undoOfId`. Author/actor come from `ctx.principal`.
- `services/note-write.ts:9` — `loadNote(ctx, id)` — workspace-scoped fetch of the current head row.
- `services/activity.ts:16` — `listActivity(ctx)` — feed, `desc(createdAt)`, `FEED_LIMIT=200`; computes `undoneIds` set and stamps each entry's `undone`.
- `services/activity.ts:35` — `undoActivity(ctx, activityId)` — the whole undo algorithm + all three guards. Returns `{ undo, note }` where `note` is `null` when the head ended up soft-deleted.
- `db/schema.ts:109` — `activityLog` table. Note `noteId`, `noteVersionId`, `resultingVersion`, `undoOfId` are all **nullable**; `undo_of_id` is the derivation source.
- `db/schema.ts:74` — `noteVersions`, with `uniqueIndex('note_versions_unique').on(noteId, version)` — one snapshot per version, ever.
- `serialize.ts:66` — `serializeActivity(row, undone)` — the `undone` boolean is passed in by the caller, not read from the row.
- `app.ts:227` / `app.ts:234` — routes. Feed needs `notes:read` scope; undo needs `requireUser(ctx.principal)` (agents forbidden).
- `test/agent-undo.test.ts` — the end-to-end spec (attribute → feed → undo → already_undone; and undo-of-create → note gone).

## How undo works (walk `undoActivity`, `services/activity.ts:35`)

1. Load target row by `(id, workspaceId)`; 404 if missing.
2. Guard `cannot_undo_undo`: reject if `target.action === 'note.undo'` (`activity.ts:43`).
3. Guard `not_undoable`: reject if `target.noteId` is null OR `target.resultingVersion === null` (`activity.ts:46`) — this is what non-note activities hit.
4. Guard `already_undone`: query for any row with `undoOfId === activityId` in this workspace; if one exists, reject (`activity.ts:51`).
5. `priorVersion = target.resultingVersion - 1`.
   - `priorVersion >= 1`: load `note_versions` at that version, restore its `title`/`bodyMd`, set `deletedAt = null` (reviving even a currently-deleted note) — `activity.ts:67`.
   - else (undoing the first `note.create`, whose `resultingVersion` is 1): set `deletedAt = new Date()` — the note ceases to exist (`activity.ts:85`).
6. Write the new head: `version = currentHead.version + 1`, plus restored title/body/deletedAt (`activity.ts:90`).
7. `recordVersionAndActivity(ctx, head, 'note.undo', target.id)` — snapshots the restored head and appends the compensating entry with `undoOfId = target.id` (`activity.ts:103`).
8. Return `{ undo, note: head.deletedAt ? null : serializeNote(head) }`.

## Playbook — verify undo of an agent edit end-to-end

Mirrors `test/agent-undo.test.ts:16`. Operator creates a note (v1), agent edits (v2), operator undoes → content back to v1, head is v3.

```ts
// note starts at version 1, bodyMd 'original by operator'
// agent PATCH with baseVersion:1 -> head version 2, activity 'note.update' resultingVersion 2
const feed = await call(app, 'GET', '/v1/activity', { token: user.token });
const edit = feed.json.activity.find(a => a.actorType === 'agent' && a.action === 'note.update');
expect(edit.undone).toBe(false);              // derived: nothing points at it yet

const undo = await call(app, 'POST', `/v1/activity/${edit.id}/undo`, { token: user.token });
expect(undo.json.note.bodyMd).toBe('original by operator'); // priorVersion (2-1=1) restored
expect(undo.json.note.version).toBe(3);        // NEW head, not a rewind

// re-read the feed: original now derives as undone, and a compensating entry exists
const feed2 = await call(app, 'GET', '/v1/activity', { token: user.token });
expect(feed2.json.activity.find(a => a.id === edit.id).undone).toBe(true);
expect(feed2.json.activity.some(a => a.action === 'note.undo')).toBe(true);

// second undo of the same action is refused
const again = await call(app, 'POST', `/v1/activity/${edit.id}/undo`, { token: user.token });
expect(again.status).toBe(400);
expect(again.json.error.code).toBe('already_undone');
```

Undo of a create (`test/agent-undo.test.ts:79`): `undo.json.note` is `null` and the note disappears from `GET /v1/notes` — the create had `resultingVersion === 1`, so step 5 soft-deletes.

## Adding a new reversible action

1. Add the action string to `ActivityAction` in `@iris/shared` (extensionless relative imports; TS 5.9.3).
2. In your service, mutate the note head (bump `version`, set `updatedAt`), then call `recordVersionAndActivity(ctx, head, 'note.yourAction')`. Do NOT insert into `activity_log`/`note_versions` by hand — the choke point keeps snapshot + entry + attribution consistent.
3. Undo works automatically **iff** the row has a real `noteId` and `resultingVersion`, and `priorVersion = resultingVersion - 1` points at a valid snapshot. See how `notes.ts` create/update/delete/restore and `sync.ts` all route through the same helper.

## Invariants & gotchas

- **Never UPDATE/DELETE `activity_log` rows.** The log is append-only; correcting a mistake means appending, not editing. `undone` is derived (`activity.ts:26`) — do not add an `undone` column or set it as state.
- **Undo is not a diff-inverse; it restores a snapshot as the new head.** Undoing a *non-latest* action loads `resultingVersion - 1` and writes it over the current head — this can clobber edits that happened after the target action. Undo is safe/idempotent-ish for the latest action; be careful reasoning about mid-history undo.
- **`resultingVersion` and the snapshot's `version` both equal `note.version` at record time** (`note-write.ts:29-52`). If you bump `version` *after* calling the helper, the snapshot is wrong. Bump first, record second (see `notes.ts:67` then `:73`).
- **Undoing a create soft-deletes** (`deletedAt = now`, `activity.ts:87`) and the endpoint returns `note: null`. Undoing anything else sets `deletedAt = null`, reviving a deleted note (`activity.ts:83`).
- **Three guards, all `badRequest(msg, code)` → HTTP 400** `{error:{code,...}}`: `cannot_undo_undo` (target is a `note.undo`), `not_undoable` (null `noteId`/`resultingVersion`), `already_undone` (a row already references it). `already_undone` is what prevents double-undo; it is a query, not a flag.
- **Undo is operator-only.** `app.ts:236` calls `requireUser(ctx.principal)` — an agent token gets rejected before `undoActivity` runs. The feed itself only needs `notes:read`.
- **Everything is workspace-scoped.** Every query in `activity.ts` filters `workspaceId` (tenant rule, ADR-003). A new query that forgets `eq(..., ctx.workspaceId)` is a tenant-isolation bug even inside RLS.
- **`note_versions` is unique on `(noteId, version)`** (`schema.ts:92`). Two writes at the same version will violate it — another reason to always go through the head-bump-then-record flow.
- **The undo snapshot is attributed to the operator**, not the original actor: `recordVersionAndActivity` reads `ctx.principal` for author/actor fields. The original action's attribution is untouched (append-only), so the audit trail shows "agent did X, operator undid it".
- **Feed is capped at `FEED_LIMIT=200`, newest first.** If an undo's target scrolled out of the window it's still undoable by id via the endpoint, but it won't render its `undone` state correctly if the *undo* row is outside the window — `undoneIds` is computed only from the fetched page (`activity.ts:26`).
