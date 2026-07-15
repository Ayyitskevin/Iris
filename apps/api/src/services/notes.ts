/**
 * Notes service — CRUD with load-bearing versioning (ADR-008) and activity logging
 * (ADR-009). Every mutation, whether by a user or an agent, (a) bumps the note version,
 * (b) writes an immutable `note_versions` snapshot, and (c) appends to `activity_log`.
 *
 * Services never open their own transactions or set the GUC — they run inside the
 * per-request tenant transaction from runTenant(), and use ctx.db throughout.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { CreateNoteRequest, Note, UpdateNoteRequest } from '@iris/shared';
import { noteVersions, notes } from '../db/schema';
import type { Ctx } from '../context';
import { conflict, notFound } from '../lib/errors';
import { isUuid, newId } from '../lib/ids';
import { serializeNote } from '../serialize';
import { loadNote, recordVersionAndActivity } from './note-write';

/** Trim, lowercase, drop empties, and de-dupe tags so "Work" and " work " collapse. */
export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export async function listNotes(ctx: Ctx, tag?: string): Promise<Note[]> {
  const filters = [eq(notes.workspaceId, ctx.workspaceId), isNull(notes.deletedAt)];
  // jsonb `?` tests membership of a string in the tags array (see migration 0002).
  if (tag) filters.push(sql`${notes.tags} ? ${tag}`);
  const rows = await ctx.db
    .select()
    .from(notes)
    .where(and(...filters))
    .orderBy(desc(notes.updatedAt));
  return rows.map(serializeNote);
}

export async function getNote(ctx: Ctx, id: string): Promise<Note> {
  const row = await loadNote(ctx, id);
  if (!row || row.deletedAt) throw notFound('Note not found');
  return serializeNote(row);
}

export async function createNote(ctx: Ctx, input: CreateNoteRequest): Promise<Note> {
  const id = input.id && isUuid(input.id) ? input.id : newId();
  const inserted = await ctx.db
    .insert(notes)
    .values({
      id,
      workspaceId: ctx.workspaceId,
      title: input.title ?? '',
      bodyMd: input.bodyMd ?? '',
      folder: input.folder ?? null,
      tags: normalizeTags(input.tags),
      version: 1,
    })
    .returning();
  const note = inserted[0]!;
  await recordVersionAndActivity(ctx, note, 'note.create');
  return serializeNote(note);
}

export async function updateNote(ctx: Ctx, id: string, input: UpdateNoteRequest): Promise<Note> {
  const current = await loadNote(ctx, id);
  if (!current || current.deletedAt) throw notFound('Note not found');

  // Optimistic concurrency: the edit must have been based on the current version,
  // otherwise it's a conflict the client must reconcile — never silently overwritten.
  if (current.version !== input.baseVersion) {
    throw conflict('This note changed since you last loaded it', serializeNote(current));
  }

  const updated = await ctx.db
    .update(notes)
    .set({
      title: input.title ?? current.title,
      bodyMd: input.bodyMd ?? current.bodyMd,
      folder: input.folder === undefined ? current.folder : input.folder,
      tags: input.tags === undefined ? current.tags : normalizeTags(input.tags),
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(notes.id, id), eq(notes.workspaceId, ctx.workspaceId)))
    .returning();
  const note = updated[0]!;
  await recordVersionAndActivity(ctx, note, 'note.update');
  return serializeNote(note);
}

export async function deleteNote(ctx: Ctx, id: string, baseVersion: number): Promise<Note> {
  const current = await loadNote(ctx, id);
  if (!current || current.deletedAt) throw notFound('Note not found');
  if (current.version !== baseVersion) {
    throw conflict('This note changed since you last loaded it', serializeNote(current));
  }

  const updated = await ctx.db
    .update(notes)
    .set({ deletedAt: new Date(), version: current.version + 1, updatedAt: new Date() })
    .where(and(eq(notes.id, id), eq(notes.workspaceId, ctx.workspaceId)))
    .returning();
  const note = updated[0]!;
  await recordVersionAndActivity(ctx, note, 'note.delete');
  return serializeNote(note);
}

/**
 * Restore a prior version's content as a new head version. History is never rewritten
 * (append-only) — restore writes a fresh version and activity entry.
 */
export async function restoreVersion(ctx: Ctx, id: string, versionId: string): Promise<Note> {
  const current = await loadNote(ctx, id);
  if (!current) throw notFound('Note not found');

  const targetRows = await ctx.db
    .select()
    .from(noteVersions)
    .where(
      and(
        eq(noteVersions.id, versionId),
        eq(noteVersions.noteId, id),
        eq(noteVersions.workspaceId, ctx.workspaceId),
      ),
    );
  const target = targetRows[0];
  if (!target) throw notFound('Version not found');

  const updated = await ctx.db
    .update(notes)
    .set({
      title: target.title,
      bodyMd: target.bodyMd,
      tags: target.tags ?? [],
      version: current.version + 1,
      deletedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(notes.id, id), eq(notes.workspaceId, ctx.workspaceId)))
    .returning();
  const note = updated[0]!;
  await recordVersionAndActivity(ctx, note, 'note.restore');
  return serializeNote(note);
}

export async function listVersions(ctx: Ctx, id: string) {
  const note = await loadNote(ctx, id);
  if (!note) throw notFound('Note not found');
  const rows = await ctx.db
    .select()
    .from(noteVersions)
    .where(and(eq(noteVersions.noteId, id), eq(noteVersions.workspaceId, ctx.workspaceId)))
    .orderBy(desc(noteVersions.version));
  return rows;
}
