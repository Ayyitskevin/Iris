/**
 * Activity service — the append-only feed of everything actors did, and the undo that
 * makes any of it reversible (pillar #2). Undo never deletes history: it restores the
 * note to its pre-action state as a NEW head version and appends a `note.undo` entry.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ActivityEntry, Note } from '@iris/shared';
import { activityLog, noteVersions, notes } from '../db/schema';
import type { Ctx } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { serializeActivity, serializeNote } from '../serialize';
import { loadNote, recordVersionAndActivity, throwConcurrentNoteChange } from './note-write';

const FEED_LIMIT = 200;

export async function listActivity(ctx: Ctx): Promise<ActivityEntry[]> {
  const rows = await ctx.db
    .select()
    .from(activityLog)
    .where(eq(activityLog.workspaceId, ctx.workspaceId))
    .orderBy(desc(activityLog.createdAt))
    .limit(FEED_LIMIT);

  // An entry is "undone" iff some other entry names it as its undoOfId. Derived, not
  // stored, so the log stays strictly append-only.
  const undoneIds = new Set(rows.map((r) => r.undoOfId).filter((v): v is string => v !== null));
  return rows.map((r) => serializeActivity(r, undoneIds.has(r.id)));
}

export interface UndoResult {
  undo: ActivityEntry;
  note: Note;
  folderRestored: boolean;
  deletionStateRestored: boolean;
}

export async function undoActivity(ctx: Ctx, activityId: string): Promise<UndoResult> {
  const targetRows = await ctx.db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.id, activityId), eq(activityLog.workspaceId, ctx.workspaceId)));
  const target = targetRows[0];
  if (!target) throw notFound('Activity entry not found');

  if (target.action === 'note.undo') {
    throw badRequest('An undo cannot itself be undone', 'cannot_undo_undo');
  }
  if (!target.noteId || target.resultingVersion === null) {
    throw badRequest('This activity has nothing to undo', 'not_undoable');
  }

  // Already undone? (some entry references this one as its undoOfId)
  const existingUndo = await ctx.db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(eq(activityLog.undoOfId, activityId), eq(activityLog.workspaceId, ctx.workspaceId)));
  if (existingUndo.length > 0) {
    throw badRequest('This action has already been undone', 'already_undone');
  }

  const note = await loadNote(ctx, target.noteId);
  if (!note) throw notFound('Note not found');
  if (note.version !== target.resultingVersion) {
    throw conflict(
      "This action is no longer the note's current head and cannot be safely undone",
      serializeNote(note),
    );
  }

  const priorVersion = target.resultingVersion - 1;
  let newTitle = note.title;
  let newBody = note.bodyMd;
  let newFolder = note.folder;
  let newTags = note.tags ?? [];
  let newDeletedAt: Date | null;
  let folderRestored = true;

  if (priorVersion >= 1) {
    // Restore the snapshot that preceded the undone action.
    const priorRows = await ctx.db
      .select()
      .from(noteVersions)
      .where(
        and(
          eq(noteVersions.noteId, target.noteId),
          eq(noteVersions.version, priorVersion),
          eq(noteVersions.workspaceId, ctx.workspaceId),
        ),
      );
    const prior = priorRows[0];
    if (!prior) {
      throw badRequest(
        'The snapshot required to undo this action is missing',
        'incomplete_history',
      );
    }
    if (prior.isDeleted === null) {
      throw badRequest(
        'The snapshot required to undo this action did not capture its live/deleted state',
        'incomplete_history',
      );
    }
    newTitle = prior.title;
    newBody = prior.bodyMd;
    newTags = prior.tags ?? [];
    folderRestored = prior.folderSnapshotKnown;
    if (folderRestored) newFolder = prior.folder;
    // Undo is a new compensating write, so recreating a tombstone records when the
    // compensation happened instead of backdating the current note.
    newDeletedAt = prior.isDeleted ? new Date() : null;
  } else {
    // Undoing the very first create => the note should cease to exist.
    newDeletedAt = new Date();
  }

  const updated = await ctx.db
    .update(notes)
    .set({
      title: newTitle,
      bodyMd: newBody,
      folder: newFolder,
      tags: newTags,
      deletedAt: newDeletedAt,
      version: note.version + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notes.id, target.noteId),
        eq(notes.workspaceId, ctx.workspaceId),
        eq(notes.version, note.version),
      ),
    )
    .returning();
  const head = updated[0] ?? (await throwConcurrentNoteChange(ctx, target.noteId));

  const { activityId: undoId } = await recordVersionAndActivity(ctx, head, 'note.undo', target.id);
  const undoRows = await ctx.db
    .select()
    .from(activityLog)
    .where(inArray(activityLog.id, [undoId]));

  return {
    undo: serializeActivity(undoRows[0]!, false),
    note: serializeNote(head),
    folderRestored,
    deletionStateRestored: true,
  };
}
