import {
  ApiRequestError,
  RESTORE_PROTOCOL_VERSION,
  type ActivityEntry,
  type Note,
  type NoteVersion,
  type RestoreVersionRequest,
  type RestoreVersionResponse,
  type SyncMutation,
  type UndoResponse,
} from '@iris/shared';
import type { ReplicaState } from './state/store';

export interface PendingRequest {
  identity: string;
  requestId: number;
}

/** Ignore completions from a prior note/owner or from an overtaken request. */
export function requestStillCurrent(
  expected: PendingRequest,
  currentIdentity: string,
  currentRequestId: number,
): boolean {
  return expected.identity === currentIdentity && expected.requestId === currentRequestId;
}

export function canRestoreHistory(input: {
  protocolVersion: number | null;
  historyHeadVersion: number | null;
  localHeadVersion: number;
  blocked: boolean;
}): boolean {
  return (
    input.protocolVersion === RESTORE_PROTOCOL_VERSION &&
    input.historyHeadVersion !== null &&
    input.historyHeadVersion === input.localHeadVersion &&
    !input.blocked
  );
}

/** A server mutation must not race a retained local draft, staged request, or conflict. */
export function noteHasPendingWork(
  noteId: string,
  outbox: readonly SyncMutation[],
  pendingPush: readonly SyncMutation[] | null,
  conflicted: boolean,
): boolean {
  return (
    conflicted ||
    outbox.some((mutation) => mutation.note.id === noteId) ||
    Boolean(pendingPush?.some((mutation) => mutation.note.id === noteId))
  );
}

/** Apply a direct server result only if no local projection appeared after dispatch. */
export function mergeAuthoritativeNoteIfSafe(
  current: ReplicaState,
  authoritative: Note,
): ReplicaState {
  if (
    noteHasPendingWork(
      authoritative.id,
      current.outbox,
      current.pendingPush,
      Boolean(current.conflicts[authoritative.id]),
    )
  ) {
    return current;
  }
  return {
    ...current,
    notes: { ...current.notes, [authoritative.id]: authoritative },
  };
}

export function conflictResolutionLabels(input: {
  serverDeleted: boolean;
  localDeletes: boolean;
}): { keepLocal: string; useServer: string } {
  return {
    keepLocal: input.serverDeleted
      ? input.localDeletes
        ? 'Keep my deletion'
        : 'Restore my draft'
      : input.localDeletes
        ? 'Delete server note'
        : 'Keep my edit',
    useServer: input.serverDeleted ? 'Keep deleted' : 'Use server version',
  };
}

/** Build the explicit protocol-2 restore consent for either kind of legacy uncertainty. */
export function buildRestoreRequest(
  version: Pick<NoteVersion, 'id' | 'folderSnapshotKnown' | 'isDeleted'>,
  baseVersion: number,
): RestoreVersionRequest {
  return {
    versionId: version.id,
    baseVersion,
    preserveCurrentFolderIfUnknown: !version.folderSnapshotKnown,
    preserveCurrentDeletionStateIfUnknown: version.isDeleted === null,
  };
}

export function versionStateLabel(version: Pick<NoteVersion, 'isDeleted'>): string {
  if (version.isDeleted === true) return 'Deleted snapshot';
  if (version.isDeleted === false) return 'Live snapshot';
  return 'Live/deleted state was not captured';
}

export function restoreVersionLabel(
  version: Pick<NoteVersion, 'isDeleted' | 'folderSnapshotKnown'>,
  currentNoteDeleted: boolean,
): string {
  if (version.isDeleted === true) return 'Restore deleted state';
  if (version.isDeleted === false) return currentNoteDeleted ? 'Restore note' : 'Restore';
  return version.folderSnapshotKnown ? 'Restore content' : 'Restore content only';
}

export function restoreResultNotice(result: RestoreVersionResponse): string {
  const notices = [
    result.note.deletedAt
      ? 'Version restored. The note is deleted.'
      : 'Version restored. The note is live.',
  ];
  if (!result.folderRestored) notices.push('The current folder was kept.');
  if (!result.deletionStateRestored) {
    notices.push('The current live/deleted state was kept.');
  }
  return notices.join(' ');
}

export function undoResultNotice(result: UndoResponse): string {
  const notices = [
    result.note.deletedAt
      ? 'Undo completed. The note is deleted.'
      : 'Undo completed. The note is live.',
  ];
  if (!result.folderRestored) notices.push('The current folder was kept.');
  if (!result.deletionStateRestored) {
    notices.push('The current live/deleted state was kept.');
  }
  return notices.join(' ');
}

/** Whole-snapshot undo is meaningful only for the latest loaded action on each note. */
export function latestUndoableActivityIds(items: ActivityEntry[]): Set<string> {
  const latestVersionByNote = new Map<string, number>();
  for (const item of items) {
    if (!item.noteId || item.resultingVersion === null) continue;
    latestVersionByNote.set(
      item.noteId,
      Math.max(latestVersionByNote.get(item.noteId) ?? -1, item.resultingVersion),
    );
  }

  return new Set(
    items
      .filter(
        (item) =>
          item.action !== 'note.undo' &&
          !item.undone &&
          item.noteId !== null &&
          item.resultingVersion !== null &&
          latestVersionByNote.get(item.noteId) === item.resultingVersion,
      )
      .map((item) => item.id),
  );
}

export type MutationFailureKind = 'conflict' | 'confirmed-rejection' | 'unconfirmed';

/** Only a known client/domain rejection proves that no mutation committed. */
export function classifyMutationFailure(error: unknown): MutationFailureKind {
  if (error instanceof ApiRequestError && error.isConflict) return 'conflict';
  if (error instanceof ApiRequestError && error.status < 500 && error.code !== 'unknown') {
    return 'confirmed-rejection';
  }
  return 'unconfirmed';
}
