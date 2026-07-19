/**
 * Notes service — CRUD with load-bearing versioning (ADR-008) and activity logging
 * (ADR-009). Every mutation, whether by a user or an agent, (a) bumps the note version,
 * (b) writes an immutable `note_versions` snapshot, and (c) appends to `activity_log`.
 *
 * Services never open their own transactions or set the GUC — they run inside the
 * per-request tenant transaction from runTenant(), and use ctx.db throughout.
 */
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  NOTES_PAGE_DEFAULT_LIMIT,
  NOTES_PAGE_MAX_LIMIT,
  type CreateNoteRequest,
  type Note,
  type RestoreVersionResponse,
  type UpdateNoteRequest,
} from '@iris/shared';
import { noteVersions, notes } from '../db/schema';
import type { Ctx } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { isUuid, newId } from '../lib/ids';
import { serializeNote } from '../serialize';
import { loadNote, recordVersionAndActivity, throwConcurrentNoteChange } from './note-write';

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

export interface ListNotesOptions {
  tag?: string;
  limit?: number;
  cursor?: string;
}

export interface ListNotesResult {
  notes: Note[];
  /** Present only when more notes remain past this page. */
  nextCursor?: string;
}

/**
 * The pagination key is `syncSeq`, not `updatedAt`: it is a per-workspace monotonic integer
 * with a unique index (notes_sync_idx), bumped on every note mutation. That makes it a stable,
 * precise, index-backed keyset — "most recently changed first" — with none of the tie or
 * millisecond-truncation hazards a timestamp cursor carries.
 */
function encodeNotesCursor(syncSeq: bigint): string {
  return Buffer.from(String(syncSeq), 'utf8').toString('base64url');
}

function decodeNotesCursor(cursor: string): bigint {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/.test(raw)) throw badRequest('Notes cursor is malformed', 'invalid_cursor');
  return BigInt(raw);
}

export async function listNotes(ctx: Ctx, opts: ListNotesOptions = {}): Promise<ListNotesResult> {
  const limit = Math.min(opts.limit ?? NOTES_PAGE_DEFAULT_LIMIT, NOTES_PAGE_MAX_LIMIT);
  const filters = [eq(notes.workspaceId, ctx.workspaceId), isNull(notes.deletedAt)];
  // jsonb `?` tests membership of a string in the tags array (see migration 0002).
  if (opts.tag) filters.push(sql`${notes.tags} ? ${opts.tag}`);
  // Keyset: rows strictly before the cursor in syncSeq-descending order.
  if (opts.cursor) filters.push(lt(notes.syncSeq, decodeNotesCursor(opts.cursor)));

  const rows = await ctx.db
    .select()
    .from(notes)
    .where(and(...filters))
    .orderBy(desc(notes.syncSeq))
    // One extra row past the page tells us whether a next page exists.
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeNotesCursor(page[page.length - 1]!.syncSeq) : undefined;
  return { notes: page.map(serializeNote), nextCursor };
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
    .where(
      and(
        eq(notes.id, id),
        eq(notes.workspaceId, ctx.workspaceId),
        eq(notes.version, current.version),
      ),
    )
    .returning();
  const note = updated[0] ?? (await throwConcurrentNoteChange(ctx, id));
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
    .where(
      and(
        eq(notes.id, id),
        eq(notes.workspaceId, ctx.workspaceId),
        eq(notes.version, current.version),
      ),
    )
    .returning();
  const note = updated[0] ?? (await throwConcurrentNoteChange(ctx, id));
  await recordVersionAndActivity(ctx, note, 'note.delete');
  return serializeNote(note);
}

/**
 * Restore a prior version's content as a new head version. History is never rewritten
 * (append-only) — restore writes a fresh version and activity entry.
 */
export async function restoreVersion(
  ctx: Ctx,
  id: string,
  versionId: string,
  baseVersion: number,
  preserveCurrentFolderIfUnknown = false,
  preserveCurrentDeletionStateIfUnknown = false,
): Promise<RestoreVersionResponse> {
  const current = await loadNote(ctx, id);
  if (!current) throw notFound('Note not found');
  if (current.version !== baseVersion) {
    throw conflict('This note changed since you opened its history', serializeNote(current));
  }

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
  if (!target.folderSnapshotKnown && !preserveCurrentFolderIfUnknown) {
    throw badRequest(
      'This legacy version did not capture its folder; explicitly preserve the current folder to restore its other fields',
      'incomplete_version_snapshot',
    );
  }
  const folderRestored = target.folderSnapshotKnown;
  if (target.isDeleted === null && !preserveCurrentDeletionStateIfUnknown) {
    throw badRequest(
      "This legacy version did not capture whether the note was deleted; explicitly preserve today's deletion state to restore its other fields",
      'incomplete_version_snapshot',
    );
  }
  const deletionStateRestored = target.isDeleted !== null;
  const now = new Date();

  const updated = await ctx.db
    .update(notes)
    .set({
      title: target.title,
      bodyMd: target.bodyMd,
      folder: folderRestored ? target.folder : current.folder,
      tags: target.tags ?? [],
      version: current.version + 1,
      deletedAt: deletionStateRestored ? (target.isDeleted ? now : null) : current.deletedAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(notes.id, id),
        eq(notes.workspaceId, ctx.workspaceId),
        eq(notes.version, current.version),
      ),
    )
    .returning();
  const note = updated[0] ?? (await throwConcurrentNoteChange(ctx, id));
  await recordVersionAndActivity(ctx, note, 'note.restore');
  return { note: serializeNote(note), folderRestored, deletionStateRestored };
}

export async function listVersions(ctx: Ctx, id: string) {
  // Keep the advertised head and the returned snapshots on one database state. Without
  // the share lock, READ COMMITTED could observe the note before a concurrent save and
  // its version row after that save, producing a history capability bound to the wrong
  // list even though restore itself would still fail safe.
  const noteRows = await ctx.db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.workspaceId, ctx.workspaceId)))
    .for('share');
  const note = noteRows[0];
  if (!note) throw notFound('Note not found');
  const rows = await ctx.db
    .select()
    .from(noteVersions)
    .where(and(eq(noteVersions.noteId, id), eq(noteVersions.workspaceId, ctx.workspaceId)))
    .orderBy(desc(noteVersions.version));
  return { versions: rows, headVersion: note.version };
}
