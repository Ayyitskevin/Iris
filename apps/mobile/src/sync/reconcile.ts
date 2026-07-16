/**
 * Pure Sync v2 reconciliation contract.
 *
 * This module has no store or network side effects. The runtime coordinator applies it
 * only while holding a checked session/workspace lease (ADR-011).
 */
import type { Note, SyncChangesResponse, SyncMutation, SyncPushResponse } from '@iris/shared';

/** Both sides of a rejected local edit. Nothing is discarded until the user decides. */
export interface SyncConflictDraft {
  noteId: string;
  localMutation: SyncMutation;
  serverNote: Note;
  detectedAt: string;
}

export interface PushReconcileState {
  notes: Record<string, Note>;
  outbox: SyncMutation[];
  conflicts: Record<string, SyncConflictDraft>;
}

export class SyncProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncProtocolError';
  }
}

/** Defensive ceiling for one drain cycle, even if every server cursor is unique. */
export const SYNC_CHANGE_PAGE_LIMIT = 1_000;

export function validatePushResponse(sent: SyncMutation[], response: SyncPushResponse): void {
  const sentByOp = new Map<string, SyncMutation>();
  for (const mutation of sent) {
    if (sentByOp.has(mutation.opId)) {
      throw new SyncProtocolError('Sync push request contained a duplicate operation id');
    }
    sentByOp.set(mutation.opId, mutation);
  }

  const seen = new Set<string>();
  const bindResult = (opId: string): SyncMutation => {
    const mutation = sentByOp.get(opId);
    if (!mutation)
      throw new SyncProtocolError('Sync push response referenced an unknown operation');
    if (seen.has(opId)) {
      throw new SyncProtocolError('Sync push response repeated an operation result');
    }
    seen.add(opId);
    return mutation;
  };

  for (const applied of response.applied) {
    const mutation = bindResult(applied.opId);
    if (!applied.note && mutation.type !== 'delete') {
      throw new SyncProtocolError('Applied upsert response omitted its authoritative note');
    }
    if (applied.note && applied.note.id !== mutation.note.id) {
      throw new SyncProtocolError('Applied response note did not match its operation');
    }
    if (applied.note && mutation.type === 'upsert' && applied.note.deletedAt !== null) {
      throw new SyncProtocolError('Applied upsert response returned a deleted note');
    }
    if (applied.note && mutation.type === 'delete' && applied.note.deletedAt === null) {
      throw new SyncProtocolError('Applied delete response returned a live note');
    }
  }
  for (const conflict of response.conflicts) {
    const mutation = bindResult(conflict.opId);
    if (conflict.serverNote.id !== mutation.note.id) {
      throw new SyncProtocolError('Conflict response note did not match its operation');
    }
  }
  if (seen.size !== sent.length) {
    throw new SyncProtocolError('Sync push response omitted an operation result');
  }
}

function localNoteRebasedOnto(
  serverNote: Note,
  mutation: SyncMutation,
  currentNote: Note | undefined,
  detectedAt: string,
): Note {
  return {
    ...serverNote,
    title: mutation.note.title,
    bodyMd: mutation.note.bodyMd,
    folder: mutation.note.folder,
    tags: mutation.note.tags,
    updatedAt: currentNote?.updatedAt ?? detectedAt,
    deletedAt: mutation.type === 'delete' ? (currentNote?.deletedAt ?? detectedAt) : null,
  };
}

/**
 * Reconcile one push response against the *current* local state.
 *
 * `sent` is the immutable request snapshot. `state.outbox` may already contain edits
 * created while that request was in flight. Only the exact sent op is acknowledged;
 * a newer op for the same note is preserved and rebased onto the server version.
 */
export function reconcilePush(
  state: PushReconcileState,
  sent: SyncMutation[],
  response: SyncPushResponse,
  detectedAt: string,
): PushReconcileState {
  validatePushResponse(sent, response);
  const notes = { ...state.notes };
  let outbox = [...state.outbox];
  const conflicts = { ...state.conflicts };
  const sentByOp = new Map(sent.map((mutation) => [mutation.opId, mutation]));

  for (const applied of response.applied) {
    const sentMutation = sentByOp.get(applied.opId);
    if (!sentMutation) continue;

    const currentPending = outbox.find((mutation) => mutation.note.id === sentMutation.note.id);
    const hasNewerPending = currentPending && currentPending.opId !== sentMutation.opId;

    if (hasNewerPending) {
      if (applied.note) {
        outbox = outbox.map((mutation) =>
          mutation.opId === currentPending.opId
            ? { ...mutation, baseVersion: applied.note!.version }
            : mutation,
        );
        notes[applied.note.id] = localNoteRebasedOnto(
          applied.note,
          currentPending,
          notes[applied.note.id],
          detectedAt,
        );
      }
      continue;
    }

    outbox = outbox.filter((mutation) => mutation.opId !== sentMutation.opId);
    if (applied.note) notes[applied.note.id] = applied.note;
    else if (sentMutation.type === 'delete') delete notes[sentMutation.note.id];
    delete conflicts[sentMutation.note.id];
  }

  for (const conflict of response.conflicts) {
    const sentMutation = sentByOp.get(conflict.opId);
    if (!sentMutation) continue;

    // If the user edited again while the request was in flight, preserve that newest
    // draft rather than the older payload that happened to reach the server.
    const currentPending = outbox.find((mutation) => mutation.note.id === sentMutation.note.id);
    const localMutation = currentPending ?? sentMutation;

    outbox = outbox.filter((mutation) => mutation.note.id !== sentMutation.note.id);
    notes[conflict.serverNote.id] = conflict.serverNote;
    conflicts[conflict.serverNote.id] = {
      noteId: conflict.serverNote.id,
      localMutation,
      serverNote: conflict.serverNote,
      detectedAt,
    };
  }

  return { notes, outbox, conflicts };
}

/** Drain every pull page now instead of leaving a partially hydrated workspace. */
export async function drainChangePages(
  initialCursor: string,
  fetchPage: (cursor: string) => Promise<SyncChangesResponse>,
  applyPage: (page: SyncChangesResponse) => void | Promise<void>,
): Promise<string> {
  let cursor = initialCursor;
  const seenCursors = new Set([initialCursor]);

  for (let pageIndex = 0; pageIndex < SYNC_CHANGE_PAGE_LIMIT; pageIndex += 1) {
    const page = await fetchPage(cursor);
    if (page.cursor === cursor && (page.hasMore || page.changes.length > 0)) {
      throw new SyncProtocolError('Sync change-feed returned changes without advancing its cursor');
    }
    if (page.cursor !== cursor && seenCursors.has(page.cursor)) {
      throw new SyncProtocolError('Sync change-feed repeated an earlier cursor');
    }
    await applyPage(page);

    if (!page.hasMore) return page.cursor;
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }

  throw new SyncProtocolError('Sync change-feed exceeded its page limit');
}
