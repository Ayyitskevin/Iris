/**
 * Sync change-feed (ADR-005). Pull deltas since a cursor; push local mutations with the
 * `base_version` each was derived from. A mismatch is a CONFLICT — surfaced with the
 * authoritative server note, never silently overwritten. All work runs in the request's
 * tenant transaction (runTenant), so a batch is atomic and workspace-scoped.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type {
  Note,
  SyncChangesResponse,
  SyncConflict,
  SyncMutation,
  SyncPushResponse,
} from '@iris/shared';
import { notes } from '../db/schema';
import type { NoteRow } from '../db/schema';
import type { Ctx } from '../context';
import { serializeNote } from '../serialize';
import { loadNote, recordVersionAndActivity } from './note-write';
import { requireRegisteredDevice } from './devices';

const PAGE = 500;

/** Result of applying one mutation: either it landed, or it conflicted. */
type ApplyResult =
  | { kind: 'applied'; item: { opId: string; note?: Note } }
  | { kind: 'conflict'; item: SyncConflict };

function encodeCursor(row: NoteRow): string {
  return `${row.updatedAt.toISOString()}|${row.id}`;
}

// Nil UUID sorts before every real id — the genesis lower bound for the (time, id) cursor.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function decodeCursor(cursor: string): { time: Date; id: string } {
  if (!cursor || cursor === 'genesis') return { time: new Date(0), id: NIL_UUID };
  const idx = cursor.lastIndexOf('|');
  if (idx < 0) return { time: new Date(0), id: NIL_UUID };
  return { time: new Date(cursor.slice(0, idx)), id: cursor.slice(idx + 1) };
}

/**
 * Return notes (including tombstones) changed after `cursor`, ordered by (updated_at,
 * id) so the cursor is a stable, monotonic high-water mark.
 */
export async function syncChanges(
  ctx: Ctx,
  cursor: string,
  deviceId: string,
): Promise<SyncChangesResponse> {
  // Pulling changes is syncing too — gate it on a registered device (ADR-007).
  await requireRegisteredDevice(ctx, deviceId);
  const { time, id } = decodeCursor(cursor);

  const rows = await ctx.db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.workspaceId, ctx.workspaceId),
        // Row-value comparison: (updated_at, id) strictly after the cursor. Casts keep
        // PGlite/Postgres from tripping over param types (timestamptz, uuid).
        sql`(${notes.updatedAt}, ${notes.id}) > (${time.toISOString()}::timestamptz, ${id}::uuid)`,
      ),
    )
    .orderBy(asc(notes.updatedAt), asc(notes.id))
    .limit(PAGE);

  const nextCursor = rows.length > 0 ? encodeCursor(rows[rows.length - 1]!) : cursor;
  return {
    changes: rows.map(serializeNote),
    cursor: nextCursor,
    hasMore: rows.length === PAGE,
  };
}

function conflictResult(m: SyncMutation, existing: NoteRow): ApplyResult {
  return {
    kind: 'conflict',
    item: { opId: m.opId, reason: 'version_mismatch', serverNote: serializeNote(existing) },
  };
}

async function applyUpsert(ctx: Ctx, m: SyncMutation): Promise<ApplyResult> {
  const existing = await loadNote(ctx, m.note.id);
  if (!existing) {
    // A note created offline. Adopt the client's id.
    const inserted = await ctx.db
      .insert(notes)
      .values({
        id: m.note.id,
        workspaceId: ctx.workspaceId,
        title: m.note.title,
        bodyMd: m.note.bodyMd,
        folder: m.note.folder,
        version: 1,
      })
      .returning();
    const note = inserted[0]!;
    await recordVersionAndActivity(ctx, note, 'note.create');
    return { kind: 'applied', item: { opId: m.opId, note: serializeNote(note) } };
  }

  if (existing.version !== m.baseVersion) return conflictResult(m, existing);

  const updated = await ctx.db
    .update(notes)
    .set({
      title: m.note.title,
      bodyMd: m.note.bodyMd,
      folder: m.note.folder,
      version: existing.version + 1,
      deletedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(notes.id, m.note.id), eq(notes.workspaceId, ctx.workspaceId)))
    .returning();
  const note = updated[0]!;
  await recordVersionAndActivity(ctx, note, 'note.update');
  return { kind: 'applied', item: { opId: m.opId, note: serializeNote(note) } };
}

async function applyDelete(ctx: Ctx, m: SyncMutation): Promise<ApplyResult> {
  const existing = await loadNote(ctx, m.note.id);
  if (!existing) {
    // Never existed here — nothing to delete; treat as an idempotent no-op success.
    return { kind: 'applied', item: { opId: m.opId } };
  }
  if (existing.deletedAt) {
    // Already a tombstone — idempotent success, echo the tombstone.
    return { kind: 'applied', item: { opId: m.opId, note: serializeNote(existing) } };
  }
  if (existing.version !== m.baseVersion) return conflictResult(m, existing);

  const updated = await ctx.db
    .update(notes)
    .set({ deletedAt: new Date(), version: existing.version + 1, updatedAt: new Date() })
    .where(and(eq(notes.id, m.note.id), eq(notes.workspaceId, ctx.workspaceId)))
    .returning();
  const note = updated[0]!;
  await recordVersionAndActivity(ctx, note, 'note.delete');
  return { kind: 'applied', item: { opId: m.opId, note: serializeNote(note) } };
}

export async function syncPush(
  ctx: Ctx,
  deviceId: string,
  mutations: SyncMutation[],
): Promise<SyncPushResponse> {
  // The multi-device gate: a device must be registered, and registration is where the
  // billing limit is enforced (ADR-007). An unregistered device cannot push.
  await requireRegisteredDevice(ctx, deviceId);

  const applied: SyncPushResponse['applied'] = [];
  const conflicts: SyncPushResponse['conflicts'] = [];

  for (const m of mutations) {
    const result = m.type === 'delete' ? await applyDelete(ctx, m) : await applyUpsert(ctx, m);
    if (result.kind === 'applied') applied.push(result.item);
    else conflicts.push(result.item);
  }

  return { applied, conflicts };
}
