import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, ApiResponseValidationError } from '@iris/shared';

const memory = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));
vi.mock('./state/storage', () => ({
  storage: {
    get: async (key: string) => memory.values.get(key) ?? null,
    set: async (key: string, value: string) => {
      memory.values.set(key, value);
    },
    remove: async (key: string) => {
      memory.values.delete(key);
    },
  },
}));

import { apiForLease, authenticatedRequest } from './api';
import { adoptSession, loadState, openSessionLease, store$, type Session } from './state/store';

const sessionA: Session = {
  token: 'fixed-token-A',
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'a@example.com',
  displayName: 'A',
};
const sessionB: Session = {
  token: 'fixed-token-B',
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'b@example.com',
  displayName: 'B',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  memory.values.clear();
  vi.restoreAllMocks();
  await loadState();
  await adoptSession(sessionA);
});

describe('fixed-token authenticated API boundary', () => {
  it('sends A token and discards its delayed response after B adoption', async () => {
    const leaseA = openSessionLease()!;
    const response = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => response.promise);
    const request = apiForLease(leaseA).billingStatus();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    await adoptSession(sessionB);
    response.resolve(
      new Response(
        JSON.stringify({
          plan: 'free',
          status: 'none',
          activeDevices: 1,
          deviceLimit: 1,
        }),
        { status: 200 },
      ),
    );

    await expect(request).rejects.toThrow('Session changed');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixed-token-A');
    expect(store$.session.get()).toEqual(sessionB);
  });

  it('rejects a stale lease before dispatching another request', async () => {
    const leaseA = openSessionLease()!;
    const clientA = apiForLease(leaseA);
    await adoptSession(sessionB);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(clientA.billingStatus()).rejects.toThrow('Session changed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('expires only the current session after a 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'unauthorized', message: 'Expired' },
        }),
        { status: 401 },
      ),
    );

    await expect(authenticatedRequest((api) => api.billingStatus())).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('auth-required');
  });
});

describe('API error classification', () => {
  it('does not confuse an idempotency collision with a note version conflict', () => {
    const version = new ApiRequestError(409, 'version_conflict', 'stale note');
    const idempotency = new ApiRequestError(
      409,
      'idempotency_key_reused',
      'operation id already bound',
    );

    expect(version.isConflict).toBe(true);
    expect(version.isIdempotencyKeyReused).toBe(false);
    expect(idempotency.isConflict).toBe(false);
    expect(idempotency.isIdempotencyKeyReused).toBe(true);
  });

  it('retains the operation id named by a sync error envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'idempotency_key_reused',
            message: 'operation id already bound',
            operationId: 'op-collision',
          },
        }),
        { status: 409 },
      ),
    );

    await expect(
      apiForLease(openSessionLease()!).syncPush({
        deviceId: store$.deviceId.get(),
        mutations: [],
      }),
    ).rejects.toMatchObject({
      code: 'idempotency_key_reused',
      operationId: 'op-collision',
    });
  });

  it('preserves a non-2xx status even when its error body is malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>bad request</html>', { status: 400 }),
    );

    await expect(
      apiForLease(openSessionLease()!).syncChanges('', store$.deviceId.get()),
    ).rejects.toMatchObject({
      status: 400,
      code: 'unknown',
    });
  });
});

describe('successful sync response validation', () => {
  it('rejects a malformed push payload with the dedicated response error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ applied: 'not-an-array', conflicts: [] }), { status: 200 }),
    );

    await expect(
      apiForLease(openSessionLease()!).syncPush({
        deviceId: store$.deviceId.get(),
        mutations: [],
      }),
    ).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  it('rejects a malformed changes payload with the dedicated response error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ changes: [], cursor: 42, hasMore: false }), { status: 200 }),
    );

    await expect(
      apiForLease(openSessionLease()!).syncChanges('', store$.deviceId.get()),
    ).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  it('classifies invalid JSON on a successful sync response the same way', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{broken', { status: 200 }));

    await expect(
      apiForLease(openSessionLease()!).syncChanges('', store$.deviceId.get()),
    ).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  it('does not let a bodyless 2xx response bypass the sync schema', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      apiForLease(openSessionLease()!).syncPush({
        deviceId: store$.deviceId.get(),
        mutations: [],
      }),
    ).rejects.toBeInstanceOf(ApiResponseValidationError);
  });
});

describe('successful version-history response validation', () => {
  const legacyVersion = {
    id: 'version-1',
    noteId: 'note-1',
    workspaceId: sessionA.workspaceId,
    version: 1,
    title: 'Legacy title',
    bodyMd: 'Legacy body',
    authorType: 'user',
    authorId: sessionA.userId,
    authorName: sessionA.displayName,
    createdAt: '2026-07-16T12:00:00.000Z',
  };

  it('normalizes fields omitted by an older server to honest legacy values', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ versions: [legacyVersion] }), { status: 200 }),
    );

    const result = await apiForLease(openSessionLease()!).listVersions('note-1');
    expect(result.restoreProtocolVersion).toBe(0);
    expect(result.headVersion).toBeUndefined();
    expect(result.versions[0]).toMatchObject({
      folder: null,
      folderSnapshotKnown: false,
      tags: [],
    });
  });

  it('rejects malformed organization metadata instead of rendering invented history', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          versions: [
            {
              ...legacyVersion,
              folder: 'projects',
              folderSnapshotKnown: 'yes',
              tags: [],
            },
          ],
          headVersion: 1,
          restoreProtocolVersion: 1,
        }),
        { status: 200 },
      ),
    );

    await expect(apiForLease(openSessionLease()!).listVersions('note-1')).rejects.toBeInstanceOf(
      ApiResponseValidationError,
    );
  });

  it('rejects a claimed known folder when the folder value is omitted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          versions: [
            {
              ...legacyVersion,
              folderSnapshotKnown: true,
              tags: [],
            },
          ],
          headVersion: 1,
          restoreProtocolVersion: 1,
        }),
        { status: 200 },
      ),
    );

    await expect(apiForLease(openSessionLease()!).listVersions('note-1')).rejects.toBeInstanceOf(
      ApiResponseValidationError,
    );
  });

  it('rejects restore protocol 1 without its authoritative head', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ versions: [legacyVersion], restoreProtocolVersion: 1 }), {
        status: 200,
      }),
    );

    await expect(apiForLease(openSessionLease()!).listVersions('note-1')).rejects.toBeInstanceOf(
      ApiResponseValidationError,
    );
  });

  it('rejects legacy field omissions under restore protocol 1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          versions: [{ ...legacyVersion, tags: [] }],
          headVersion: 1,
          restoreProtocolVersion: 1,
        }),
        { status: 200 },
      ),
    );

    await expect(apiForLease(openSessionLease()!).listVersions('note-1')).rejects.toBeInstanceOf(
      ApiResponseValidationError,
    );
  });

  it('keeps a future restore protocol readable but distinguishable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          versions: [
            {
              ...legacyVersion,
              folder: null,
              folderSnapshotKnown: false,
              tags: [],
            },
          ],
          headVersion: 1,
          restoreProtocolVersion: 2,
        }),
        { status: 200 },
      ),
    );

    const result = await apiForLease(openSessionLease()!).listVersions('note-1');
    expect(result.restoreProtocolVersion).toBe(2);
    expect(result.versions).toHaveLength(1);
  });

  it('rejects an older restore response that cannot prove its folder result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          note: {
            id: 'note-1',
            workspaceId: sessionA.workspaceId,
            title: 'Restored',
            bodyMd: 'Body',
            folder: 'current/folder',
            tags: ['legacy'],
            version: 2,
            createdAt: '2026-07-16T12:00:00.000Z',
            updatedAt: '2026-07-16T12:01:00.000Z',
            deletedAt: null,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      apiForLease(openSessionLease()!).restoreVersion('note-1', {
        versionId: 'version-1',
        baseVersion: 1,
        preserveCurrentFolderIfUnknown: true,
      }),
    ).rejects.toBeInstanceOf(ApiResponseValidationError);
  });
});

describe('successful activity response validation', () => {
  const activity = {
    id: 'activity-1',
    workspaceId: sessionA.workspaceId,
    actorType: 'user',
    actorId: sessionA.userId,
    actorName: sessionA.displayName,
    action: 'note.update',
    noteId: 'note-1',
    noteVersionId: 'version-2',
    resultingVersion: 2,
    createdAt: '2026-07-16T12:01:00.000Z',
    undone: false,
    undoOfId: null,
  };

  it('marks an older activity server as lacking head-guarded undo', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ activity: [activity] }), { status: 200 }),
    );

    const result = await apiForLease(openSessionLease()!).listActivity();
    expect(result.undoProtocolVersion).toBe(0);
    expect(result.activity).toHaveLength(1);
  });

  it('keeps a future undo protocol readable but distinguishable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ activity: [activity], undoProtocolVersion: 2 }), {
        status: 200,
      }),
    );

    const result = await apiForLease(openSessionLease()!).listActivity();
    expect(result.undoProtocolVersion).toBe(2);
    expect(result.activity).toHaveLength(1);
  });

  it('rejects an older undo response that cannot prove its organization result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ undo: activity, note: null }), { status: 200 }),
    );

    await expect(apiForLease(openSessionLease()!).undoActivity(activity.id)).rejects.toBeInstanceOf(
      ApiResponseValidationError,
    );
  });

  it('rejects malformed undo organization metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ undo: activity, note: null, folderRestored: 'yes' }), {
        status: 200,
      }),
    );

    await expect(apiForLease(openSessionLease()!).undoActivity(activity.id)).rejects.toBeInstanceOf(
      ApiResponseValidationError,
    );
  });
});
