/** Shared note-write helpers used by the notes and activity (undo) services. */
import { and, eq } from 'drizzle-orm';
import type { ActivityAction } from '@iris/shared';
import { activityLog, noteVersions, notes } from '../db/schema';
import type { NoteRow } from '../db/schema';
import type { Ctx } from '../context';
import { conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { serializeNote } from '../serialize';

export async function loadNote(ctx: Ctx, id: string): Promise<NoteRow | undefined> {
  const rows = await ctx.db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.workspaceId, ctx.workspaceId)));
  return rows[0];
}

/** Convert a lost compare-and-swap into the latest authoritative API state. */
export async function throwConcurrentNoteChange(
  ctx: Ctx,
  id: string,
  message = 'This note changed while your request was being saved',
): Promise<never> {
  const latest = await loadNote(ctx, id);
  if (!latest) throw notFound('Note not found');
  throw conflict(message, serializeNote(latest));
}

/**
 * Append an immutable version snapshot for `note`'s current state and an activity
 * entry describing the action that produced it. This is the single choke point that
 * makes every mutation attributable and reversible (pillar #2).
 */
export async function recordVersionAndActivity(
  ctx: Ctx,
  note: NoteRow,
  action: ActivityAction,
  undoOfId: string | null = null,
): Promise<{ versionId: string; activityId: string }> {
  const versionId = newId();
  await ctx.db.insert(noteVersions).values({
    id: versionId,
    noteId: note.id,
    workspaceId: ctx.workspaceId,
    version: note.version,
    title: note.title,
    bodyMd: note.bodyMd,
    folder: note.folder,
    folderSnapshotKnown: true,
    tags: note.tags ?? [],
    authorType: ctx.principal.type,
    authorId: ctx.principal.id,
    authorName: ctx.principal.name,
  });

  const activityId = newId();
  await ctx.db.insert(activityLog).values({
    id: activityId,
    workspaceId: ctx.workspaceId,
    actorType: ctx.principal.type,
    actorId: ctx.principal.id,
    actorName: ctx.principal.name,
    action,
    noteId: note.id,
    noteVersionId: versionId,
    resultingVersion: note.version,
    undoOfId,
  });

  return { versionId, activityId };
}
