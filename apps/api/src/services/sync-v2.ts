/**
 * Additive generic Sync v2 adapter. `notes-v1` is an immutable resource set backed by
 * the existing note feed and frozen receipt-v1 mutation semantics. New resource kinds
 * require a new set/cursor namespace and receipt version before this boundary widens.
 */
import { and, asc, eq, gt, lte } from 'drizzle-orm';
import {
  PostgresUuid,
  SYNC_PULL_PAGE_LIMIT,
  SYNC_PULL_PAGE_MAX_BYTES,
  SYNC_PUSH_RESPONSE_MAX_BYTES,
  SYNC_V2_RESOURCE_SET,
  utf8ByteLength,
  type Note,
  type SyncMutation,
  type SyncV2ChangesRequest,
  type SyncV2ChangesResponse,
  type SyncV2Mutation,
  type SyncV2NoteResource,
  type SyncV2PushRequest,
  type SyncV2PushResponse,
} from '@iris/shared';
import { notes, workspaceSyncCursors } from '../db/schema';
import type { Ctx } from '../context';
import { badRequest } from '../lib/errors';
import { serializeNote } from '../serialize';
import { requireRegisteredDevice } from './devices';
import { syncPush } from './sync';

const RESOURCE_CURSOR = /^resource-v1:([^:]+):([^:]+):(0|[1-9][0-9]*)$/;

function encodeCursor(workspaceId: string, sequence: bigint): string {
  return `resource-v1:${SYNC_V2_RESOURCE_SET}:${workspaceId}:${sequence}`;
}

function decodeCursor(cursor: string, workspaceId: string): bigint {
  if (cursor === '') return 0n;
  const match = RESOURCE_CURSOR.exec(cursor);
  if (!match || match[1] !== SYNC_V2_RESOURCE_SET || !PostgresUuid.safeParse(match[2]).success) {
    throw badRequest(
      'Sync cursor is malformed or belongs to another resource set',
      'invalid_sync_cursor',
    );
  }
  if (match[2]!.toLowerCase() !== workspaceId.toLowerCase()) {
    throw badRequest('Sync cursor belongs to another workspace', 'invalid_sync_cursor');
  }
  return BigInt(match[3]!);
}

function noteResource(note: Note): SyncV2NoteResource {
  const { id, ...data } = note;
  return { type: 'note', id, data };
}

/**
 * Pull one high-water-bounded page. The generic cursor is intentionally not accepted by
 * `/v1`, and vice versa. Exhausting this immutable resource set advances across any
 * sequence slots owned by resources outside the set without making them skippable by a
 * future superset cursor.
 */
export async function syncV2Changes(
  ctx: Ctx,
  request: SyncV2ChangesRequest,
): Promise<SyncV2ChangesResponse> {
  await requireRegisteredDevice(ctx, request.deviceId);
  const sequence = decodeCursor(request.cursor, ctx.workspaceId);
  const counterRows = await ctx.db
    .select({ lastSeq: workspaceSyncCursors.lastSeq })
    .from(workspaceSyncCursors)
    .where(eq(workspaceSyncCursors.workspaceId, ctx.workspaceId));
  const highWater = counterRows[0]?.lastSeq ?? 0n;
  if (sequence > highWater) {
    throw badRequest('Sync cursor is ahead of this workspace', 'invalid_sync_cursor');
  }

  const rows = await ctx.db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.workspaceId, ctx.workspaceId),
        gt(notes.syncSeq, sequence),
        lte(notes.syncSeq, highWater),
      ),
    )
    .orderBy(asc(notes.syncSeq))
    .limit(SYNC_PULL_PAGE_LIMIT + 1);

  const resources: SyncV2ChangesResponse['resources'] = [];
  let responseBytes = utf8ByteLength(
    JSON.stringify({
      resourceSet: SYNC_V2_RESOURCE_SET,
      resources: [],
      cursor: encodeCursor(ctx.workspaceId, highWater),
      hasMore: false,
    }),
  );
  for (const row of rows.slice(0, SYNC_PULL_PAGE_LIMIT)) {
    const resource = noteResource(serializeNote(row));
    const nextBytes =
      responseBytes + utf8ByteLength(JSON.stringify(resource)) + (resources.length === 0 ? 0 : 1);
    // Preserve one recognized pre-limit oversized note losslessly. Every ordinary page
    // and every subsequent page remains bounded by the complete generic envelope.
    if (resources.length > 0 && nextBytes > SYNC_PULL_PAGE_MAX_BYTES) break;
    resources.push(resource);
    responseBytes = nextBytes;
  }

  const hasMore = rows[resources.length] !== undefined;
  const nextSequence = hasMore ? rows[resources.length - 1]!.syncSeq : highWater;
  return {
    resourceSet: SYNC_V2_RESOURCE_SET,
    resources,
    cursor: encodeCursor(ctx.workspaceId, nextSequence),
    hasMore,
  };
}

function legacyMutation(mutation: SyncV2Mutation): SyncMutation {
  return {
    opId: mutation.opId,
    type: mutation.type,
    note: {
      id: mutation.resource.id,
      title: mutation.resource.data.title,
      bodyMd: mutation.resource.data.bodyMd,
      folder: mutation.resource.data.folder,
      tags: mutation.resource.data.tags,
    },
    baseVersion: mutation.baseVersion,
  };
}

/**
 * Project strict note envelopes into the frozen receipt-v1 operation and wrap its exact
 * applied/conflict outcome only after the existing service has replayed or committed it.
 */
export async function syncV2Push(
  ctx: Ctx,
  request: SyncV2PushRequest,
): Promise<SyncV2PushResponse> {
  const legacy = await syncPush(ctx, request.deviceId, request.mutations.map(legacyMutation));
  const response: SyncV2PushResponse = {
    resourceSet: SYNC_V2_RESOURCE_SET,
    applied: legacy.applied.map((item) => ({
      opId: item.opId,
      resource: item.note ? noteResource(item.note) : undefined,
    })),
    conflicts: legacy.conflicts.map((item) => ({
      opId: item.opId,
      reason: item.reason,
      serverResource: noteResource(item.serverNote),
    })),
  };

  const resultCount = response.applied.length + response.conflicts.length;
  if (resultCount > 1 && utf8ByteLength(JSON.stringify(response)) > SYNC_PUSH_RESPONSE_MAX_BYTES) {
    // Throwing inside the tenant transaction rolls back notes, history, activity, cursor
    // movement, and receipts. The caller can split the exact operations into smaller batches.
    throw badRequest(
      'Serialized sync response exceeds the Iris transport limit; split this batch',
      'sync_response_too_large',
    );
  }
  return response;
}
