import { ApiRequestError, type ActivityEntry } from '@iris/shared';

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
    input.protocolVersion === 1 &&
    input.historyHeadVersion !== null &&
    input.historyHeadVersion === input.localHeadVersion &&
    !input.blocked
  );
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
