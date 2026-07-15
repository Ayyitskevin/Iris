---
name: notes-and-versioning
description: Open when touching note CRUD, version history, the baseVersion 409-conflict path, restore/undo, or soft delete — anything that mutates a note or reads its history.
---

## When to use
- Adding or changing a note mutation (title/body/folder/delete/restore) in `apps/api`.
- A save is silently clobbering a concurrent edit, or a client is getting an unexpected `409 version_conflict`.
- `note_versions` history is missing an entry, has a duplicate-version DB error, or attribution (`authorName`) is wrong.
- Implementing/fixing restore or undo, or debugging why a "deleted" note still (or no longer) shows up.
- Wiring a new `/v1/notes/...` route to a service method.

## Mental model
`notes` holds the **single mutable head** of each note (`version` counter, `deletedAt` for soft delete). `note_versions` is an **append-only, immutable snapshot table**: one row per `(noteId, version)`, capturing the note's state *after* each mutation. Every note write follows the same shape — load current, guard, `UPDATE ... version = current.version + 1`, then call `recordVersionAndActivity`. That helper is the **single choke point** (`services/note-write.ts`) that makes every change attributable (writes a `note_versions` snapshot + an `activity_log` row) and reversible. Concurrency is **optimistic**: the client sends the `baseVersion` it edited against; if it no longer equals the head, the write is rejected as a `409 version_conflict` carrying the authoritative server note — never a silent overwrite. Nothing is ever destroyed: delete is a soft flag, restore and undo write **new head versions** rather than rewriting history.

## Key files
- `apps/api/src/services/notes.ts` — the CRUD service: `listNotes`, `getNote`, `createNote`, `updateNote`, `deleteNote`, `restoreVersion`, `listVersions`. Every mutation ends in `recordVersionAndActivity`.
- `apps/api/src/services/note-write.ts` — `loadNote(ctx,id)` (workspace-scoped fetch) and `recordVersionAndActivity(ctx, note, action, undoOfId?)` — THE choke point. Snapshots `note`'s current state into `note_versions` and appends an `activity_log` row. Shared by notes, sync, and undo.
- `apps/api/src/db/schema.ts` — `notes` (head: `version`, `deletedAt`, `notes_sync_idx`), `noteVersions` (immutable; `uniqueIndex('note_versions_unique').on(noteId, version)`), `activityLog`. Mirror of hand-authored `migrations/0001_init.sql` — keep both in sync.
- `apps/api/src/lib/errors.ts` — `conflict(msg, serverNote)` → `HttpError(409,'version_conflict', …, serverNote)`; `notFound(...)` → 404. These become the `{error:{code,message,conflict?}}` envelope in `app.ts`.
- `apps/api/src/serialize.ts` — `serializeNote` / `serializeVersion`: Row → wire type (Dates → ISO strings). The service returns already-serialized `Note`; `listVersions` returns **raw rows** — the route maps them with `serializeVersion`.
- `apps/api/src/app.ts` (~L140-198) — the `/v1/notes*` routes. Each wraps `tenant(req, ctx => …)`, calls `requireScope(ctx,'notes:read'|'notes:write')`, then the service.
- `apps/api/src/services/sync.ts` & `services/activity.ts` — other callers of `recordVersionAndActivity` (push create/update/delete, and `note.undo`). Change the choke-point signature and you touch all three.
- `apps/api/test/versioning.test.ts` — the executable spec for save/restore/conflict. Run/extend it when changing this area.

## Playbook
Add a mutating note operation the correct way — worked example: a `setFolder` endpoint. Copy the `updateNote` shape exactly.

1. **Service method** in `services/notes.ts`. Load, guard existence + soft-delete, enforce `baseVersion`, bump version, record, serialize:
```ts
export async function setFolder(
  ctx: Ctx, id: string, folder: string | null, baseVersion: number,
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
    .where(and(eq(notes.id, id), eq(notes.workspaceId, ctx.workspaceId)))
    .returning();
  const note = updated[0]!;
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
    return { note: await notesService.setFolder(ctx, (req.params as {id:string}).id, folder, baseVersion) };
  }),
);
```
   Validate `req.body` with a zod schema from `@iris/shared` (see `CreateNoteRequest`/`UpdateNoteRequest`/`RestoreVersionRequest` usage) rather than raw casts for anything non-trivial.
4. **Test** it in `test/versioning.test.ts` style: `signUp` → create → mutate with the right `baseVersion` (expect `version` to increment, a new `note_versions` row) → mutate again with a stale `baseVersion` (expect `409`, `error.code === 'version_conflict'`, `error.conflict` = server note). Run `pnpm --filter @iris/api test`.
5. If the mutation adds a **column**, edit `schema.ts` AND `migrations/0001_init.sql` together, and update `serializeNote` if it should reach the wire.

## Invariants & gotchas
- **Choke point is mandatory.** Every note mutation (create/update/delete/restore/undo/sync-push) ends in `recordVersionAndActivity`. A raw `UPDATE notes` without it is a bug.
- **Snapshot is the *resulting* state, not the prior one.** `recordVersionAndActivity` writes `note_versions.version = note.version` from the row *after* the update. So `note_versions[v]` == the note's content at version `v` (create writes the `v1` snapshot too). Restore-of-`v1` therefore copies `v1`'s title/body forward as a new head.
- **Bump version by exactly 1 before recording.** `note_versions_unique(noteId, version)` will throw on a duplicate. Recording twice for the same resulting version, or forgetting to increment, is a constraint violation.
- **`baseVersion` conflicts are HTTP 409 / `version_conflict`** and carry the server note in `error.conflict`. Update, delete, and sync-push all enforce it; **restore does NOT** — it always writes `current.version + 1` with no `baseVersion` check.
- **Restore & undo are append-only and revive.** `restoreVersion` sets `deletedAt: null`, so restoring a version un-deletes the note; it loads even a soft-deleted note (only 404s if the row is truly absent). Undo (`activity.ts`) undoing the first create re-soft-deletes the note.
- **Soft delete only.** `deleteNote` sets `deletedAt` (+version bump + `note.delete` activity); rows are never hard-deleted. `listNotes`/`getNote`/`updateNote`/`deleteNote` treat `deletedAt` as not-found (double-delete → 404). Any new read must add `isNull(notes.deletedAt)` (see `listNotes`) or it will surface tombstones.
- **Partial-update null semantics differ per field.** `updateNote` uses `input.title ?? current.title` and `input.bodyMd ?? current.bodyMd` (null/undefined both keep the old value — you cannot null these), but `input.folder === undefined ? current.folder : input.folder` (explicit `null` *does* clear folder). Match the intended semantics when copying.
- **Attribution comes from `ctx.principal`**, not request args — `authorType/authorId/authorName` (and `activity_log.actor*`) are stamped from the acting user or agent token. Don't let callers spoof it.
- **Everything is workspace-scoped.** `loadNote` and every query filter by `ctx.workspaceId`; services never open transactions or set the RLS GUC — they run inside `runTenant`'s single per-request transaction on `ctx.db`. A query without a `workspaceId` predicate is a tenancy leak.
- **`listVersions` returns raw `NoteVersionRow[]`, not `Note`s.** The `app.ts` route maps them through `serializeVersion`; a new caller must serialize itself. Versions are returned newest-first (`orderBy(desc(version))`).
- **Keep `schema.ts` and `migrations/0001_init.sql` in sync** — the SQL is hand-authored to carry RLS policies; Drizzle does not generate it.
