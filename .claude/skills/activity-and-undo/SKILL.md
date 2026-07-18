---
name: activity-and-undo
description: Open when touching the activity feed, the undo endpoint, note_versions/activity_log rows, or debugging why an action shows (or won't show) as undone.
---

## When to use

- Adding a new reversible action, or making an existing mutation show up in the feed / be undoable.
- Bug: "undone" flag is wrong, an action can't be undone, or undo restored the wrong content.
- Touching `activity_log`, `note_versions`, or the `POST /v1/activity/:id/undo` route.
- Understanding why undo produces a _new_ version instead of rewinding, or why undoing a create deletes the note.
- Adding a non-note activity (e.g. token issuance) and wondering why it returns `not_undoable`.

## Mental model

The activity log is **append-only**: rows in `activity_log` are never updated or deleted. Every note mutation goes through the single choke point `recordVersionAndActivity` (`services/note-write.ts`), which writes an immutable `note_versions` snapshot of the recorded note fields plus one `activity_log` row describing the action. Undo is not a mutation of history — it is a _forward_ action that restores the currently supported pre-action content as a **new head version** and appends a compensating `note.undo` entry whose `undoOfId` points back at the reversed action. Because of this, "was this action undone?" is **derived at read time**: an entry is undone iff some other row names it as `undoOfId` (`services/activity.ts`). There is no `undone` column. Undo is operator-only (`requireUser`); agents can act but cannot undo. Undo restores the prior snapshot's **title, body, tags, and exact known folder**, and restores its captured **live/deleted state** — so undo can revive a note _or_ re-create a tombstone (with a fresh timestamp), and it is stricter than direct restore: a missing or lifecycle-unknown prior snapshot returns `incomplete_history` and writes nothing (no preserve opt-out). Mutations are `POST /v2/activity/:id/undo` (the `/v1` path is inert — `428 undo_protocol_upgrade_required`).

## Key files

- `services/note-write.ts` — `recordVersionAndActivity(ctx, note, action, undoOfId=null)`. THE choke point. It snapshots `note.version`, writes the activity row, and stamps author/actor from `ctx.principal`; `loadNote(ctx, id)` is the workspace-scoped current-head fetch.
- `services/activity.ts` — `listActivity(ctx)` (newest first, `FEED_LIMIT=200`,
  derived `undone`) and `undoActivity(ctx, activityId)` (the algorithm and guards).
- `db/schema.ts` — `activityLog` plus workspace-composite `noteVersions`.
  `noteId`, `noteVersionId`, `resultingVersion`, and `undoOfId` are nullable;
  `note_versions_unique` covers workspace + note + version.
- `serialize.ts` — `serializeActivity(row, undone)`; the `undone` boolean is passed
  by the caller, not stored on the row.
- `app.ts` — feed and undo routes. Feed needs `notes:read`; undo needs
  `requireUser(ctx.principal)` (agents forbidden).
- `test/agent-undo.test.ts` — the end-to-end spec (attribute → feed → undo → already_undone; and undo-of-create → note gone).

## How undo works (walk `undoActivity`, `services/activity.ts:35`)

1. Load target row by `(id, workspaceId)`; 404 if missing.
2. Guard `cannot_undo_undo`: reject if `target.action === 'note.undo'` (`activity.ts:43`).
3. Guard `not_undoable`: reject if `target.noteId` is null OR `target.resultingVersion === null` (`activity.ts:46`) — this is what non-note activities hit.
4. Guard `already_undone`: query for any row with `undoOfId === activityId` in this workspace; if one exists, reject (`activity.ts:51`).
5. `priorVersion = target.resultingVersion - 1`.
   - `priorVersion >= 1`: load the `note_versions` snapshot at that version. If it is **missing**, or its lifecycle was never captured (`is_deleted === null`), reject with `incomplete_history` and write **nothing** — undo has no "preserve current state" opt-out. Otherwise restore its `title`, `bodyMd`, `tags`, and — when `folder_snapshot_known` — its exact `folder`; set `deletedAt` from the captured state (`prior.isDeleted ? now : null`), so undo **re-creates a tombstone** (fresh timestamp) when the prior snapshot was itself deleted rather than always reviving.
   - else (undoing the first `note.create`, whose `resultingVersion` is 1): tombstone the note — `deletedAt = new Date()` — so it ceases to exist (tags/folder are left as-is since the note is going away).
6. Write the new head: `version = currentHead.version + 1`, plus the restored title/body/tags/folder/deletedAt.
7. `recordVersionAndActivity(ctx, head, 'note.undo', target.id)` — snapshots the restored head and appends the compensating entry with `undoOfId = target.id`.
8. Return `{ undo, note: serializeNote(head), folderRestored, deletionStateRestored: true }`. The authoritative note is **always** returned, even when it is now a tombstone — **never `null`**. `deletionStateRestored` is always literally `true` on success (an unknown prior lifecycle would have thrown `incomplete_history` at step 5).

## Playbook — verify undo of an agent edit end-to-end

Mirrors `test/agent-undo.test.ts:16`. Operator creates a note (v1), agent edits (v2), operator undoes → content back to v1, head is v3.

```ts
// note starts at version 1, bodyMd 'original by operator'
// agent PATCH with baseVersion:1 -> head version 2, activity 'note.update' resultingVersion 2
const feed = await call(app, 'GET', '/v1/activity', { token: user.token });
const edit = feed.json.activity.find((a) => a.actorType === 'agent' && a.action === 'note.update');
expect(edit.undone).toBe(false); // derived: nothing points at it yet

const undo = await call(app, 'POST', `/v1/activity/${edit.id}/undo`, { token: user.token });
expect(undo.json.note.bodyMd).toBe('original by operator'); // priorVersion (2-1=1) restored
expect(undo.json.note.version).toBe(3); // NEW head, not a rewind

// re-read the feed: original now derives as undone, and a compensating entry exists
const feed2 = await call(app, 'GET', '/v1/activity', { token: user.token });
expect(feed2.json.activity.find((a) => a.id === edit.id).undone).toBe(true);
expect(feed2.json.activity.some((a) => a.action === 'note.undo')).toBe(true);

// second undo of the same action is refused
const again = await call(app, 'POST', `/v1/activity/${edit.id}/undo`, { token: user.token });
expect(again.status).toBe(400);
expect(again.json.error.code).toBe('already_undone');
```

Undo of a create (`test/agent-undo.test.ts`): `undo.json.note` is the **tombstone** — its `deletedAt` is set, it is **not** `null` — and the note disappears from `GET /v1/notes`; the create had `resultingVersion === 1`, so step 5 tombstones it.

## Adding a new reversible action

1. Add the action string to `ActivityAction` in `@iris/shared` (extensionless relative imports; TS 5.9.3).
2. In your service, mutate the note head (bump `version`, set `updatedAt`), then call `recordVersionAndActivity(ctx, head, 'note.yourAction')`. Do NOT insert into `activity_log`/`note_versions` by hand — the choke point keeps snapshot + entry + attribution consistent.
3. Whole-snapshot undo works automatically **iff** the row has a real `noteId` and
   `resultingVersion`, and `priorVersion = resultingVersion - 1` points at a valid snapshot
   whose lifecycle is known. Because `recordVersionAndActivity` snapshots title, body, tags,
   folder (+ `folder_snapshot_known`) and lifecycle (`is_deleted`), undo restores all of them
   for free — but a **new** mutable field you add needs its own snapshot column, restore
   wiring, and focused undo coverage; do not assume the choke point captures a field you just
   added.

## Invariants & gotchas

- **Never UPDATE/DELETE `activity_log` rows.** The log is append-only; correcting a mistake means appending, not editing. `undone` is derived (`activity.ts:26`) — do not add an `undone` column or set it as state.
- **Undo is not a diff-inverse; it restores supported snapshot fields as the new head.**
  Undoing a _non-latest_ action loads `resultingVersion - 1` and writes title/body over
  the current head — this can clobber later content while retaining current folder/tags.
  Undo is safe/idempotent-ish for the latest action; be careful reasoning about
  mid-history undo.
- **`resultingVersion` and the snapshot's `version` both equal `note.version` at record time** (`note-write.ts:29-52`). If you bump `version` _after_ calling the helper, the snapshot is wrong. Bump first, record second (see `notes.ts:67` then `:73`).
- **Undo restores the prior snapshot's captured lifecycle — not always a revival.** Undoing a
  create tombstones the note (`deletedAt = now`); undoing anything else restores
  `prior.isDeleted ? now : null`, so it revives a deleted note _or_ re-creates a tombstone. The
  endpoint **always returns the authoritative note** — even a tombstone — **never `null`**, plus
  `folderRestored` and `deletionStateRestored: true`. A client must not branch on `note == null`.
- **Four guards, all `badRequest(msg, code)` → HTTP 400** `{error:{code,...}}`: `cannot_undo_undo`
  (target is a `note.undo`), `not_undoable` (null `noteId`/`resultingVersion`), `already_undone`
  (a row already references it — a query, not a flag, and what prevents double-undo), and
  `incomplete_history` (the prior snapshot is missing or its live/deleted state was never
  captured — undo then writes nothing). Undo has **no** "preserve current state" opt-out, unlike
  direct restore's `incomplete_version_snapshot` + `preserve*` flags.
- **Undo is operator-only.** `app.ts:236` calls `requireUser(ctx.principal)` — an agent token gets rejected before `undoActivity` runs. The feed itself only needs `notes:read`.
- **Everything is workspace-scoped.** Every query in `activity.ts` filters `workspaceId` (tenant rule, ADR-003). A new query that forgets `eq(..., ctx.workspaceId)` is a tenant-isolation bug even inside RLS.
- **`note_versions` is unique on `(workspace_id, note_id, version)`.** Two writes at
  the same version in one workspace will violate it — another reason to always use the
  head-bump-then-record flow.
- **The undo snapshot is attributed to the operator**, not the original actor: `recordVersionAndActivity` reads `ctx.principal` for author/actor fields. The original action's attribution is untouched (append-only), so the audit trail shows "agent did X, operator undid it".
- **Feed is capped at `FEED_LIMIT=200`, newest first.** If an undo's target scrolled out of the window it's still undoable by id via the endpoint, but it won't render its `undone` state correctly if the _undo_ row is outside the window — `undoneIds` is computed only from the fetched page (`activity.ts:26`).
