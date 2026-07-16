---
name: notes-and-versioning
description: Open when touching note CRUD, version history, baseVersion/CAS conflicts, restore/undo, or soft delete — anything that mutates a note or reads its history.
---

## When to use

- Adding or changing a note mutation (title/body/folder/delete/restore) in `apps/api`.
- A save is silently clobbering a concurrent edit, or a client is getting an unexpected `409 version_conflict`.
- `note_versions` history is missing an entry, has a duplicate-version DB error, or attribution (`authorName`) is wrong.
- Implementing/fixing restore or undo, or debugging why a "deleted" note still (or no longer) shows up.
- Wiring a new `/v1/notes/...` route to a service method.

## Mental model

`notes` holds the **single mutable head** of each note (`version` counter, `deletedAt` for soft delete). `note_versions` is an **append-only, immutable snapshot table**: one row per `(workspaceId, noteId, version)`, capturing the recorded title/body/tags state _after_ each mutation. Every existing-note update path uses CAS — load current, guard, `UPDATE ... WHERE version = current.version` while setting `version = current.version + 1`, then call `recordVersionAndActivity`. That helper is the **single choke point** (`services/note-write.ts`) that makes every change attributable (writes a `note_versions` snapshot + an `activity_log` row). Concurrency is **optimistic**: a pre-check rejects an already-stale base, and the UPDATE compare-and-swap closes the race after that read. Nothing is hard-deleted: delete is a soft flag, restore and undo write **new head versions** rather than rewriting history. Exact organizational-field reversibility remains incomplete because snapshots omit folder and activity undo does not restore tags; ROADMAP tracks that as a separate correctness slice.

## Key files

- `apps/api/src/services/notes.ts` — the CRUD service: `listNotes`, `getNote`, `createNote`, `updateNote`, `deleteNote`, `restoreVersion`, `listVersions`. Every mutation ends in `recordVersionAndActivity`.
- `apps/api/src/services/note-write.ts` — workspace load, authoritative lost-CAS conflict, and the version/activity recording choke point. Shared by notes, sync, and undo.
- `apps/api/src/db/schema.ts` — `notes` (workspace-composite head:
  `version`, `deletedAt`, `syncSeq` + unique `notes_sync_idx`), `noteVersions`
  (immutable; `note_versions_unique` covers workspace + note + version), and
  `activityLog`. Mirrors hand-authored migrations 0001–0003 — keep them in sync.
- `apps/api/src/lib/errors.ts` — `conflict(msg, serverNote)` → `HttpError(409,'version_conflict', …, serverNote)`; `notFound(...)` → 404. These become the `{error:{code,message,conflict?,operationId?}}` envelope in `app.ts`; this REST error is the case that carries `conflict`.
- `apps/api/src/serialize.ts` — `serializeNote` / `serializeVersion`: Row → wire type (Dates → ISO strings). The service returns already-serialized `Note`; `listVersions` returns **raw rows** — the route maps them with `serializeVersion`.
- `apps/api/src/app.ts` (~L140-198) — the `/v1/notes*` routes. Each wraps `tenant(req, ctx => …)`, calls `requireScope(ctx,'notes:read'|'notes:write')`, then the service.
- `apps/api/src/services/sync.ts` & `services/activity.ts` — other callers of `recordVersionAndActivity` (push create/update/delete, and `note.undo`). Change the choke-point signature and you touch all three.
- `apps/api/test/versioning.test.ts` — the executable spec for save/restore/conflict. Run/extend it when changing this area.

## Playbook

Add a mutating note operation the correct way — worked example: a `setFolder` endpoint. Copy the `updateNote` shape exactly.

1. **Service method** in `services/notes.ts`. Load, guard existence + soft-delete, enforce `baseVersion`, bump version, record, serialize:

```ts
export async function setFolder(
  ctx: Ctx,
  id: string,
  folder: string | null,
  baseVersion: number,
): Promise<Note> {
  const current = await loadNote(ctx, id);
  if (!current || current.deletedAt) throw notFound('Note not found');
  // Optimistic concurrency — reject stale edits, never silently overwrite.
  if (current.version !== baseVersion) {
    throw conflict('This note changed since you last loaded it', serializeNote(current));
  }
  const updated = await ctx.db
    .update(notes)
    .set({ folder, version: current.version + 1, updatedAt: new Date() })
    .where(
      and(
        eq(notes.id, id),
        eq(notes.workspaceId, ctx.workspaceId),
        eq(notes.version, current.version),
      ),
    )
    .returning();
  const note = updated[0] ?? (await throwConcurrentNoteChange(ctx, id));
  await recordVersionAndActivity(ctx, note, 'note.update'); // choke point — do NOT skip
  return serializeNote(note);
}
```

2. **Never** write `notes` and then forget `recordVersionAndActivity` — that produces a version with no snapshot and no audit row (breaks pillar #2 and undo). The version bump (`+1`) and the record call are a pair.
3. **Route** in `app.ts`, mirroring the existing PATCH handler — `notes:write` scope, run inside `tenant`:

```ts
app.patch('/v1/notes/:id/folder', guarded, (req) =>
  tenant(req, async (ctx) => {
    requireScope(ctx, 'notes:write');
    const { folder, baseVersion } = req.body as { folder: string | null; baseVersion: number };
    return {
      note: await notesService.setFolder(
        ctx,
        (req.params as { id: string }).id,
        folder,
        baseVersion,
      ),
    };
  }),
);
```

Validate `req.body` with a Zod schema from `@iris/shared` rather than raw casts for anything non-trivial.

4. **Test** it in `test/versioning.test.ts` style: `signUp` → create → mutate with the right `baseVersion` (expect `version` to increment and a new `note_versions` row) → mutate again with a stale `baseVersion` (expect `409 version_conflict` with the authoritative note). Include a raced zero-row CAS case when the path has any pre-write awaits.

5. If the mutation adds a **column**, edit `schema.ts`, add a new higher-numbered migration, and update `serializeNote` if it should reach the wire. Never edit shipped 0001–0003 files.

## Invariants & gotchas

- **Choke point is mandatory.** Every note mutation (create/update/delete/restore/undo/sync-push) ends in `recordVersionAndActivity`. A raw `UPDATE notes` without it is a bug.
- **Snapshot is the _resulting_ state, not the prior one.** `recordVersionAndActivity` writes `note_versions.version = note.version` from the row _after_ the update. So `note_versions[v]` == the note's content at version `v` (create writes the `v1` snapshot too). Restore-of-`v1` therefore copies `v1`'s title/body forward as a new head.
- **Bump version by exactly 1 before recording.**
  `note_versions_unique(workspace_id, note_id, version)` will throw on a duplicate.
  Recording twice for the same resulting version, or forgetting to increment, is a
  constraint violation.
- **REST `baseVersion` conflicts are HTTP 409 / `version_conflict`** and carry the
  server note in `error.conflict`. Sync-push returns version mismatches per operation
  in an HTTP 200 response. Restore and undo accept no caller `baseVersion`, but still
  use the loaded version as a CAS token and conflict if another writer wins.
- **Restore & undo are append-only and revive, but not yet field-complete.**
  `restoreVersion` restores title/body/tags and sets `deletedAt: null`, but keeps the
  current folder because versions do not snapshot it. Activity undo restores
  title/body/deleted state but not folder/tags. Undoing the first create re-soft-deletes
  the note. Keep the ROADMAP correctness slice open until those fields and tests land.
- **Soft delete only.** `deleteNote` sets `deletedAt` (+version bump + `note.delete` activity); rows are never hard-deleted. `listNotes`/`getNote`/`updateNote`/`deleteNote` treat `deletedAt` as not-found (double-delete → 404). Any new read must add `isNull(notes.deletedAt)` (see `listNotes`) or it will surface tombstones.
- **Partial-update null semantics differ per field.** `updateNote` uses `input.title ?? current.title` and `input.bodyMd ?? current.bodyMd` (null/undefined both keep the old value — you cannot null these), but `input.folder === undefined ? current.folder : input.folder` (explicit `null` _does_ clear folder). Match the intended semantics when copying.
- **Attribution comes from `ctx.principal`**, not request args — `authorType/authorId/authorName` (and `activity_log.actor*`) are stamped from the acting user or agent token. Don't let callers spoof it.
- **Everything is workspace-scoped.** `loadNote` and every query filter by `ctx.workspaceId`; services never open transactions or set the RLS GUC — they run inside `runTenant`'s single per-request transaction on `ctx.db`. A query without a `workspaceId` predicate is a tenancy leak.
- **`listVersions` returns raw `NoteVersionRow[]`, not `Note`s.** The `app.ts` route maps them through `serializeVersion`; a new caller must serialize itself. Versions are returned newest-first (`orderBy(desc(version))`).
- **Keep `schema.ts` and all numbered migrations in sync.** Shipped SQL is immutable;
  add a higher-numbered file for every applied-schema change.
