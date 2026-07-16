import { describe, expect, it } from 'vitest';
import {
  ApiRequestError,
  RESTORE_PROTOCOL_VERSION,
  type ActivityEntry,
  type Note,
  type SyncMutation,
} from '@iris/shared';
import {
  buildRestoreRequest,
  canRestoreHistory,
  classifyMutationFailure,
  conflictResolutionLabels,
  latestUndoableActivityIds,
  noteHasPendingWork,
  requestStillCurrent,
  restoreResultNotice,
  restoreVersionLabel,
  undoResultNotice,
  versionStateLabel,
} from './history-safety';

function activity(
  id: string,
  noteId: string,
  resultingVersion: number,
  overrides: Partial<ActivityEntry> = {},
): ActivityEntry {
  return {
    id,
    workspaceId: 'workspace-1',
    actorType: 'user',
    actorId: 'user-1',
    actorName: 'Operator',
    action: 'note.update',
    noteId,
    noteVersionId: `version-${resultingVersion}`,
    resultingVersion,
    createdAt: '2026-07-16T12:00:00.000Z',
    undone: false,
    undoOfId: null,
    ...overrides,
  };
}

function note(deleted = false): Note {
  return {
    id: 'note-a',
    workspaceId: 'workspace-1',
    title: 'Title',
    bodyMd: 'Body',
    folder: null,
    tags: [],
    version: 3,
    createdAt: '2026-07-16T12:00:00.000Z',
    updatedAt: '2026-07-16T12:01:00.000Z',
    deletedAt: deleted ? '2026-07-16T12:01:00.000Z' : null,
  };
}

function mutation(noteId: string, opId: string): SyncMutation {
  return {
    opId,
    type: 'upsert',
    note: { id: noteId, title: 'Draft', bodyMd: 'Body', folder: null, tags: [] },
    baseVersion: 2,
  };
}

describe('history and undo safety decisions', () => {
  it('rejects delayed completions after either a route switch or a newer request', () => {
    const pending = { identity: 'owner-a:note-a', requestId: 4 };
    expect(requestStillCurrent(pending, 'owner-a:note-a', 4)).toBe(true);
    expect(requestStillCurrent(pending, 'owner-a:note-b', 4)).toBe(false);
    expect(requestStillCurrent(pending, 'owner-a:note-a', 5)).toBe(false);
  });

  it('allows restore only on the negotiated protocol and the frozen matching head', () => {
    const exact = {
      protocolVersion: RESTORE_PROTOCOL_VERSION,
      historyHeadVersion: 7,
      localHeadVersion: 7,
      blocked: false,
    };
    expect(canRestoreHistory(exact)).toBe(true);
    expect(canRestoreHistory({ ...exact, localHeadVersion: 8 })).toBe(false);
    expect(canRestoreHistory({ ...exact, protocolVersion: 0 })).toBe(false);
    expect(canRestoreHistory({ ...exact, protocolVersion: 1 })).toBe(false);
    expect(canRestoreHistory({ ...exact, protocolVersion: 3 })).toBe(false);
    expect(canRestoreHistory({ ...exact, blocked: true })).toBe(false);
  });

  it('blocks a server mutation for same-note outbox, staged, or conflict work', () => {
    const outbox = [mutation('note-a', 'outbox')];
    const staged = [mutation('note-b', 'staged')];

    expect(noteHasPendingWork('note-a', outbox, null, false)).toBe(true);
    expect(noteHasPendingWork('note-b', [], staged, false)).toBe(true);
    expect(noteHasPendingWork('note-c', [], null, true)).toBe(true);
    expect(noteHasPendingWork('note-c', outbox, staged, false)).toBe(false);
  });

  it('builds explicit consent for both independently unknown legacy fields', () => {
    expect(
      buildRestoreRequest({ id: 'legacy', folderSnapshotKnown: false, isDeleted: null }, 7),
    ).toEqual({
      versionId: 'legacy',
      baseVersion: 7,
      preserveCurrentFolderIfUnknown: true,
      preserveCurrentDeletionStateIfUnknown: true,
    });
    expect(
      buildRestoreRequest({ id: 'current', folderSnapshotKnown: true, isDeleted: false }, 8),
    ).toEqual({
      versionId: 'current',
      baseVersion: 8,
      preserveCurrentFolderIfUnknown: false,
      preserveCurrentDeletionStateIfUnknown: false,
    });
  });

  it('makes tombstone conflict choices explicit', () => {
    expect(conflictResolutionLabels({ serverDeleted: true, localDeletes: false })).toEqual({
      keepLocal: 'Restore my draft',
      useServer: 'Keep deleted',
    });
    expect(conflictResolutionLabels({ serverDeleted: false, localDeletes: true })).toEqual({
      keepLocal: 'Delete server note',
      useServer: 'Use server version',
    });
  });

  it('labels live, deleted, and unknown history without guessing', () => {
    expect(versionStateLabel({ isDeleted: false })).toBe('Live snapshot');
    expect(versionStateLabel({ isDeleted: true })).toBe('Deleted snapshot');
    expect(versionStateLabel({ isDeleted: null })).toBe('Live/deleted state was not captured');
    expect(restoreVersionLabel({ isDeleted: true, folderSnapshotKnown: true }, false)).toBe(
      'Restore deleted state',
    );
    expect(restoreVersionLabel({ isDeleted: false, folderSnapshotKnown: true }, true)).toBe(
      'Restore note',
    );
    expect(restoreVersionLabel({ isDeleted: null, folderSnapshotKnown: false }, false)).toBe(
      'Restore content only',
    );
  });

  it('announces authoritative lifecycle outcomes and retained legacy state', () => {
    expect(
      restoreResultNotice({
        note: note(true),
        folderRestored: false,
        deletionStateRestored: false,
      }),
    ).toBe(
      'Version restored. The note is deleted. The current folder was kept. The current live/deleted state was kept.',
    );
    expect(
      undoResultNotice({
        undo: activity('undo', 'note-a', 4, { action: 'note.undo' }),
        note: note(false),
        folderRestored: true,
        deletionStateRestored: true,
      }),
    ).toBe('Undo completed. The note is live.');
  });

  it('offers whole-snapshot undo only for the latest loaded action per note', () => {
    const items = [
      activity('a3', 'note-a', 3),
      activity('a2', 'note-a', 2),
      activity('b2', 'note-b', 2, { undone: true }),
      activity('b1', 'note-b', 1),
      activity('undo', 'note-c', 4, { action: 'note.undo' }),
    ];

    expect([...latestUndoableActivityIds(items)]).toEqual(['a3']);
  });

  it('treats lost, malformed, unknown, and server-error outcomes as unconfirmed', () => {
    expect(classifyMutationFailure(new ApiRequestError(409, 'version_conflict', 'stale'))).toBe(
      'conflict',
    );
    expect(classifyMutationFailure(new ApiRequestError(400, 'validation_error', 'bad'))).toBe(
      'confirmed-rejection',
    );
    expect(classifyMutationFailure(new ApiRequestError(502, 'upstream_error', 'bad gateway'))).toBe(
      'unconfirmed',
    );
    expect(classifyMutationFailure(new ApiRequestError(400, 'unknown', 'proxy'))).toBe(
      'unconfirmed',
    );
    expect(classifyMutationFailure(new Error('connection lost'))).toBe('unconfirmed');
  });
});
