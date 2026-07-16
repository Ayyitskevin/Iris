import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ActivityEntry } from '@iris/shared';
import {
  canRestoreHistory,
  classifyMutationFailure,
  latestUndoableActivityIds,
  requestStillCurrent,
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

describe('history and undo safety decisions', () => {
  it('rejects delayed completions after either a route switch or a newer request', () => {
    const pending = { identity: 'owner-a:note-a', requestId: 4 };
    expect(requestStillCurrent(pending, 'owner-a:note-a', 4)).toBe(true);
    expect(requestStillCurrent(pending, 'owner-a:note-b', 4)).toBe(false);
    expect(requestStillCurrent(pending, 'owner-a:note-a', 5)).toBe(false);
  });

  it('allows restore only on the negotiated protocol and the frozen matching head', () => {
    const exact = {
      protocolVersion: 1,
      historyHeadVersion: 7,
      localHeadVersion: 7,
      blocked: false,
    };
    expect(canRestoreHistory(exact)).toBe(true);
    expect(canRestoreHistory({ ...exact, localHeadVersion: 8 })).toBe(false);
    expect(canRestoreHistory({ ...exact, protocolVersion: 0 })).toBe(false);
    expect(canRestoreHistory({ ...exact, protocolVersion: 2 })).toBe(false);
    expect(canRestoreHistory({ ...exact, blocked: true })).toBe(false);
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
