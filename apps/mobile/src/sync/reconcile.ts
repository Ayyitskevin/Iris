/**
 * Pure Sync v1 reconciliation contract.
 *
 * This module deliberately has no store or network side effects and is not wired into
 * the runtime sync manager yet. Integration waits for the separately reviewed
 * session/workspace ownership fence and delayed-response concurrency tests (ADR-011).
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

  for (;;) {
    const page = await fetchPage(cursor);
    await applyPage(page);

    if (!page.hasMore) return page.cursor;
    if (page.cursor === cursor) {
      throw new Error('Sync change-feed returned hasMore without advancing its cursor');
    }
    cursor = page.cursor;
  }
}
