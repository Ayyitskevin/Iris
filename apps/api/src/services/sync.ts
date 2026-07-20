/**
 * Sync v2 change-feed (ADR-005/ADR-011). Pull deltas by database-monotonic cursor;
 * push local mutations with the `base_version` each was derived from. Every operation
 * id is durably bound to its actor, device, and exact payload in the same tenant
 * transaction as its result, so a lost response can be replayed without double-apply.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  PostgresUuid,
  SYNC_PULL_PAGE_LIMIT,
  SYNC_PULL_PAGE_MAX_BYTES,
  utf8ByteLength,
  type SyncChangesResponse,
  type SyncMutation,
  type SyncPushResponse,
} from '@iris/shared';
import { notes, syncIdempotency, workspaceSyncCursors, type NoteRow } from '../db/schema';
import type { Ctx } from '../context';
import { badRequest, idempotencyKeyReused, syncReceiptIncomplete } from '../lib/errors';
import { serializeNote } from '../serialize';
import { loadNote, recordVersionAndActivity } from './note-write';
import { requireRegisteredDevice } from './devices';
import { normalizeTags } from './notes';

const CURRENT_RECEIPT_VERSION = 1;
const PULL_ENVELOPE_OVERHEAD_BYTES = 512;

// How long an operation receipt is retained before garbage collection (audit #15). Receipts
// exist to make a lost-response retry replay its exact outcome; real clients retry within
// seconds to minutes, so 30 days is far past any legitimate retry window. Past it, a "replay"
// is not a retry — the note version has long since moved on, so re-applying yields a normal
// version conflict (or an idempotent no-op for deletes), never a double-apply. Bounding the
// row age keeps sync_idempotency from growing without limit for the life of a workspace.
export const SYNC_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Receipt V1 is intentionally frozen instead of importing mutable current wire schemas.
const StoredNoteV1 = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  folder: z.string().nullable(),
  tags: z.array(z.string()),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
const StoredApplyResultV1 = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('applied'),
    item: z.object({ opId: z.string(), note: StoredNoteV1.optional() }),
  }),
  z.object({
    kind: z.literal('conflict'),
    item: z.object({
      opId: z.string(),
      reason: z.literal('version_mismatch'),
      serverNote: StoredNoteV1,
    }),
  }),
]);
type ApplyResult =
  | { kind: 'applied'; item: SyncPushResponse['applied'][number] }
  | { kind: 'conflict'; item: SyncPushResponse['conflicts'][number] };

function encodeCursor(workspaceId: string, sequence: bigint): string {
  return `v2:${workspaceId}:${sequence}`;
}

const V2_BOUND_CURSOR = /^v2:([^:]+):(0|[1-9][0-9]*)$/;
const V2_UNBOUND_CURSOR = /^v2:(0|[1-9][0-9]*)$/;
const LEGACY_CURSOR =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(
  cursor: string,
  workspaceId: string,
): { sequence: bigint; needsUpgrade: boolean } {
  if (!cursor || cursor === 'genesis') return { sequence: 0n, needsUpgrade: true };
  const bound = V2_BOUND_CURSOR.exec(cursor);
  if (bound && PostgresUuid.safeParse(bound[1]).success) {
    if (bound[1]!.toLowerCase() !== workspaceId.toLowerCase()) {
      throw badRequest('Sync cursor belongs to another workspace', 'invalid_sync_cursor');
    }
    return { sequence: BigInt(bound[2]!), needsUpgrade: false };
  }
  // Legacy timestamp cursors and the short-lived draft unbound V2 cursor have no trusted
  // workspace provenance. A safe full replay upgrades either form to a bound cursor.
  if (V2_UNBOUND_CURSOR.test(cursor) || LEGACY_CURSOR.test(cursor)) {
    return { sequence: 0n, needsUpgrade: true };
  }
  throw badRequest('Sync cursor is malformed', 'invalid_sync_cursor');
}

/**
 * Return notes (including tombstones) changed after `cursor`, ordered by the sequence
 * assigned while holding the workspace commit-serialization lock.
 */
export async function syncChanges(
  ctx: Ctx,
  cursor: string,
  deviceId: string,
): Promise<SyncChangesResponse> {
  // Pulling changes is syncing too — gate it on a registered device (ADR-007).
  await requireRegisteredDevice(ctx, deviceId);
  const decoded = decodeCursor(cursor, ctx.workspaceId);
  const counterRows = await ctx.db
    .select({ lastSeq: workspaceSyncCursors.lastSeq })
    .from(workspaceSyncCursors)
    .where(eq(workspaceSyncCursors.workspaceId, ctx.workspaceId));
  const highWater = counterRows[0]?.lastSeq ?? 0n;
  if (decoded.sequence > highWater) {
    throw badRequest('Sync cursor is ahead of this workspace', 'invalid_sync_cursor');
  }

  const rows = await ctx.db
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, ctx.workspaceId), gt(notes.syncSeq, decoded.sequence)))
    .orderBy(asc(notes.syncSeq))
    // One extra row is the hasMore sentinel. Byte-budgeting may stop earlier.
    .limit(SYNC_PULL_PAGE_LIMIT + 1);

  const changes: SyncChangesResponse['changes'] = [];
  let responseBytes = PULL_ENVELOPE_OVERHEAD_BYTES;
  for (const row of rows.slice(0, SYNC_PULL_PAGE_LIMIT)) {
    const note = serializeNote(row);
    const nextBytes =
      responseBytes + utf8ByteLength(JSON.stringify(note)) + (changes.length === 0 ? 0 : 1);
    // A single recognized legacy note is still returned losslessly even if it predates
    // today's size bound. Every subsequent page remains byte-bounded.
    if (changes.length > 0 && nextBytes > SYNC_PULL_PAGE_MAX_BYTES) break;
    changes.push(note);
    responseBytes = nextBytes;
  }

  const nextSequence =
    rows[changes.length - 1]?.syncSeq ?? (decoded.needsUpgrade ? highWater : decoded.sequence);
  return {
    changes,
    cursor: encodeCursor(ctx.workspaceId, nextSequence),
    hasMore: rows[changes.length] !== undefined,
  };
}

function requestFingerprintV1(ctx: Ctx, deviceId: string, mutation: SyncMutation): string {
  // Construct the object explicitly so property ordering is deterministic across
  // runtimes. opId is the receipt key; the fingerprint binds everything it names.
  const canonical = JSON.stringify({
    actorType: ctx.principal.type,
    actorId: ctx.principal.id,
    deviceId,
    operation: {
      type: mutation.type,
      note: {
        id: mutation.note.id,
        title: mutation.note.title,
        bodyMd: mutation.note.bodyMd,
        folder: mutation.note.folder,
        tags: mutation.note.tags,
      },
      baseVersion: mutation.baseVersion,
    },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function requestFingerprint(
  receiptVersion: number,
  ctx: Ctx,
  deviceId: string,
  mutation: SyncMutation,
): string {
  if (receiptVersion === 1) return requestFingerprintV1(ctx, deviceId, mutation);
  // Unknown versions must not be fingerprinted as current-v1 — that would silently
  // mis-bind a future envelope. Callers treat this as a terminal receipt failure.
  throw syncReceiptIncomplete(
    mutation.opId,
    `Unsupported sync receipt version ${receiptVersion}`,
  );
}

function parseStoredOutcome(
  receiptVersion: number,
  outcome: unknown,
  operationId: string,
): ApplyResult {
  if (receiptVersion !== 1) {
    // Fail closed: never re-apply against an unknown durable envelope.
    throw syncReceiptIncomplete(
      operationId,
      `Unsupported sync receipt version ${receiptVersion}`,
    );
  }
  // A claimed receipt with null/malformed outcome is incomplete persistence — not a
  // signal to re-run the mutation. Re-apply would risk double-write if the original
  // side effects partially landed outside the receipt row.
  const replay = StoredApplyResultV1.safeParse(outcome);
  if (!replay.success) {
    throw syncReceiptIncomplete(
      operationId,
      'Stored sync idempotency outcome is incomplete or invalid',
    );
  }
  return replay.data;
}

async function applyIdempotently(
  ctx: Ctx,
  deviceId: string,
  mutation: SyncMutation,
): Promise<ApplyResult> {
  const fingerprint = requestFingerprint(CURRENT_RECEIPT_VERSION, ctx, deviceId, mutation);
  const inserted = await ctx.db
    .insert(syncIdempotency)
    .values({
      workspaceId: ctx.workspaceId,
      opId: mutation.opId,
      actorType: ctx.principal.type,
      actorId: ctx.principal.id,
      deviceId,
      receiptVersion: CURRENT_RECEIPT_VERSION,
      requestFingerprint: fingerprint,
      outcome: null,
    })
    .onConflictDoNothing()
    .returning({ opId: syncIdempotency.opId });

  if (inserted.length === 0) {
    const existing = await ctx.db
      .select()
      .from(syncIdempotency)
      .where(
        and(
          eq(syncIdempotency.workspaceId, ctx.workspaceId),
          eq(syncIdempotency.opId, mutation.opId),
        ),
      );
    const receipt = existing[0];
    if (
      !receipt ||
      receipt.actorType !== ctx.principal.type ||
      receipt.actorId !== ctx.principal.id ||
      receipt.deviceId !== deviceId
    ) {
      throw idempotencyKeyReused(mutation.opId);
    }
    const expectedFingerprint = requestFingerprint(receipt.receiptVersion, ctx, deviceId, mutation);
    if (receipt.requestFingerprint !== expectedFingerprint) {
      throw idempotencyKeyReused(mutation.opId);
    }
    return parseStoredOutcome(receipt.receiptVersion, receipt.outcome, mutation.opId);
  }

  let result: ApplyResult;
  switch (mutation.type) {
    case 'upsert':
      result = await applyUpsert(ctx, mutation);
      break;
    case 'delete':
      result = await applyDelete(ctx, mutation);
      break;
    case 'resurrect':
      result = await applyResurrect(ctx, mutation);
      break;
  }
  const recorded = await ctx.db
    .update(syncIdempotency)
    .set({ outcome: result })
    .where(
      and(
        eq(syncIdempotency.workspaceId, ctx.workspaceId),
        eq(syncIdempotency.opId, mutation.opId),
        eq(syncIdempotency.receiptVersion, CURRENT_RECEIPT_VERSION),
        eq(syncIdempotency.requestFingerprint, fingerprint),
      ),
    )
    .returning({ opId: syncIdempotency.opId });
  if (recorded.length !== 1) throw new Error('Could not finalize sync idempotency receipt');
  return result;
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
    if (m.baseVersion !== 0) {
      throw badRequest(
        'A missing note can only be created from baseVersion 0',
        'invalid_sync_base_version',
      );
    }
    // A note created offline. Adopt the client's id.
    const inserted = await ctx.db
      .insert(notes)
      .values({
        id: m.note.id,
        workspaceId: ctx.workspaceId,
        title: m.note.title,
        bodyMd: m.note.bodyMd,
        folder: m.note.folder,
        tags: normalizeTags(m.note.tags),
        version: 1,
      })
      .onConflictDoNothing()
      .returning();
    const note = inserted[0];
    if (!note) {
      // Another operation created this id after our read. Surface its committed head
      // instead of leaking a duplicate-key 500 from a normal optimistic race.
      const raced = await loadNote(ctx, m.note.id);
      if (raced) return conflictResult(m, raced);
      throw new Error('Concurrent note create did not expose an authoritative row');
    }
    await recordVersionAndActivity(ctx, note, 'note.create');
    return { kind: 'applied', item: { opId: m.opId, note: serializeNote(note) } };
  }

  // Editing content and reviving a deleted note are distinct operator intents. Even an
  // exact base version must retain both sides until the user explicitly chooses restore.
  if (existing.deletedAt) return conflictResult(m, existing);
  if (existing.version !== m.baseVersion) return conflictResult(m, existing);

  const updated = await ctx.db
    .update(notes)
    .set({
      title: m.note.title,
      bodyMd: m.note.bodyMd,
      folder: m.note.folder,
      tags: normalizeTags(m.note.tags),
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notes.id, m.note.id),
        eq(notes.workspaceId, ctx.workspaceId),
        eq(notes.version, existing.version),
      ),
    )
    .returning();
  const note = updated[0];
  if (!note) {
    // The workspace sequence trigger serializes commits, but the initial read happens
    // before that statement trigger. The compare-and-swap predicate closes that gap.
    const raced = await loadNote(ctx, m.note.id);
    if (raced) return conflictResult(m, raced);
    throw new Error('Concurrent note update removed its authoritative row');
  }
  await recordVersionAndActivity(ctx, note, 'note.update');
  return { kind: 'applied', item: { opId: m.opId, note: serializeNote(note) } };
}

async function applyResurrect(ctx: Ctx, m: SyncMutation): Promise<ApplyResult> {
  const existing = await loadNote(ctx, m.note.id);
  if (!existing) {
    throw badRequest(
      'A resurrect mutation requires an existing tombstone',
      'invalid_sync_resurrection',
    );
  }
  // A resurrect intent was reviewed against a tombstone. If another write has already
  // made it live, surface that authoritative head instead of applying a redundant edit.
  if (!existing.deletedAt || existing.version !== m.baseVersion) {
    return conflictResult(m, existing);
  }

  const updated = await ctx.db
    .update(notes)
    .set({
      title: m.note.title,
      bodyMd: m.note.bodyMd,
      folder: m.note.folder,
      tags: normalizeTags(m.note.tags),
      version: existing.version + 1,
      deletedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notes.id, m.note.id),
        eq(notes.workspaceId, ctx.workspaceId),
        eq(notes.version, existing.version),
      ),
    )
    .returning();
  const note = updated[0];
  if (!note) {
    const raced = await loadNote(ctx, m.note.id);
    if (raced) return conflictResult(m, raced);
    throw new Error('Concurrent note resurrection removed its authoritative row');
  }
  // `note.restore` is already understood by old activity clients and makes the explicit
  // lifecycle compensation attributable and undoable back to the prior tombstone.
  await recordVersionAndActivity(ctx, note, 'note.restore');
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
    .where(
      and(
        eq(notes.id, m.note.id),
        eq(notes.workspaceId, ctx.workspaceId),
        eq(notes.version, existing.version),
      ),
    )
    .returning();
  const note = updated[0];
  if (!note) {
    const raced = await loadNote(ctx, m.note.id);
    if (!raced) return { kind: 'applied', item: { opId: m.opId } };
    if (raced.deletedAt) {
      return { kind: 'applied', item: { opId: m.opId, note: serializeNote(raced) } };
    }
    return conflictResult(m, raced);
  }
  await recordVersionAndActivity(ctx, note, 'note.delete');
  return { kind: 'applied', item: { opId: m.opId, note: serializeNote(note) } };
}

/**
 * Delete this workspace's operation receipts older than the retention window. Scoped to the
 * current workspace, so it runs inside the push transaction that already holds the workspace
 * sync lock — no cross-workspace scan and no separate GC scheduler. Returns the count deleted.
 */
export async function gcExpiredReceipts(
  ctx: Ctx,
  retentionMs: number = SYNC_RECEIPT_RETENTION_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs);
  const deleted = await ctx.db
    .delete(syncIdempotency)
    .where(
      and(eq(syncIdempotency.workspaceId, ctx.workspaceId), lt(syncIdempotency.createdAt, cutoff)),
    )
    .returning({ opId: syncIdempotency.opId });
  return deleted.length;
}

export async function syncPush(
  ctx: Ctx,
  deviceId: string,
  mutations: SyncMutation[],
): Promise<SyncPushResponse> {
  // The multi-device gate: a device must be registered, and registration is where the
  // billing limit is enforced (ADR-007). An unregistered device cannot push.
  await requireRegisteredDevice(ctx, deviceId);

  if (mutations.length > 0) {
    // All sync batches for a workspace take this row lock before touching operation
    // receipts. The note trigger uses the same lock, so reversed op-id orders cannot
    // form a receipt-row/workspace-row deadlock cycle.
    await ctx.db
      .insert(workspaceSyncCursors)
      .values({ workspaceId: ctx.workspaceId, lastSeq: 0n })
      .onConflictDoUpdate({
        target: workspaceSyncCursors.workspaceId,
        set: { lastSeq: sql`${workspaceSyncCursors.lastSeq}` },
      });
  }

  const applied: SyncPushResponse['applied'] = [];
  const conflicts: SyncPushResponse['conflicts'] = [];

  for (const m of mutations) {
    const result = await applyIdempotently(ctx, deviceId, m);
    if (result.kind === 'applied') applied.push(result.item);
    else conflicts.push(result.item);
  }

  // Best moment to prune: we already hold this workspace's sync lock, so the delete is
  // naturally serialized against every other push for the same tenant. Only runs on a
  // non-empty batch, so it costs at most one extra statement per push that did work.
  if (mutations.length > 0) await gcExpiredReceipts(ctx);

  return { applied, conflicts };
}
