import { describe, expect, it, vi } from 'vitest';
import {
  ApiRequestError,
  ApiResponseValidationError,
  SYNC_PUSH_LIMIT,
  SYNC_PUSH_MAX_BYTES,
  syncPushRequestByteLength,
  type RegisterDeviceRequest,
  type SyncChangesResponse,
  type SyncMutation,
  type SyncPushRequest,
  type SyncPushResponse,
} from '@iris/shared';
import type { ReplicaState, SessionLease, SyncStatus } from '../state/store';
import { createSyncCoordinator, SYNC_PUSH_CHUNK_LIMIT, type SyncPort } from './coordinator';

const workspaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const noteId = '33333333-3333-4333-8333-333333333333';

function note(workspaceId: string, bodyMd = 'body', version = 1) {
  return {
    id: noteId,
    workspaceId,
    title: 'Title',
    bodyMd,
    folder: null,
    tags: [],
    version,
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
    deletedAt: null,
  };
}

function mutation(opId: string, bodyMd: string, baseVersion = 1): SyncMutation {
  return {
    opId,
    type: 'upsert',
    note: { id: noteId, title: 'Title', bodyMd, folder: null, tags: [] },
    baseVersion,
  };
}

function appliedPush(body: SyncPushRequest): SyncPushResponse {
  return {
    applied: body.mutations.map((item) => ({
      opId: item.opId,
      note: {
        ...note(workspaceA, item.note.bodyMd, item.baseVersion + 1),
        id: item.note.id,
        title: item.note.title,
        folder: item.note.folder,
        tags: item.note.tags,
      },
    })),
    conflicts: [],
  };
}

function makeQueue(
  count: number,
  opPrefix = 'op',
): {
  notes: ReplicaState['notes'];
  queued: SyncMutation[];
} {
  const notes: ReplicaState['notes'] = {};
  const queued = Array.from({ length: count }, (_, index) => {
    const id = `33333333-3333-4333-8333-${(index + 1).toString(16).padStart(12, '0')}`;
    const item = {
      ...mutation(`${opPrefix}-${index}`, `body-${index}`),
      note: { ...mutation(`${opPrefix}-${index}`, `body-${index}`).note, id },
    };
    notes[id] = { ...note(workspaceA, item.note.bodyMd), id };
    return item;
  });
  return { notes, queued };
}

function emptyReplica(cursor = ''): ReplicaState {
  return {
    notes: {},
    syncCursor: cursor,
    deviceId: '',
    outbox: [],
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class MemoryPort implements SyncPort {
  generation = 0;
  current: SessionLease | null = null;
  replicas = new Map<string, ReplicaState>();
  statuses = new Map<string, SyncStatus>();
  gated = new Map<string, boolean>();
  expired: string[] = [];
  nextUpdateError: Error | null = null;
  nextAppliedUpdateError: Error | null = null;
  afterNextApply: (() => void) | null = null;
  private controller = new AbortController();

  adopt(which: 'A' | 'B', token = 'token-' + which): SessionLease {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation += 1;
    const workspaceId = which === 'A' ? workspaceA : workspaceB;
    const userId = which === 'A' ? userA : userB;
    const ownerKey = workspaceId + '.' + userId;
    const lease: SessionLease = Object.freeze({
      token,
      userId,
      workspaceId,
      email: which.toLowerCase() + '@example.com',
      displayName: which,
      generation: this.generation,
      ownerKey,
      deviceId: 'device-' + which,
      signal: this.controller.signal,
    });
    this.current = lease;
    if (!this.replicas.has(ownerKey)) {
      this.replicas.set(ownerKey, { ...emptyReplica(), deviceId: lease.deviceId });
    }
    return lease;
  }

  signOut(): void {
    this.controller.abort();
    this.generation += 1;
    this.current = null;
  }

  captureLease = (): SessionLease | null => this.current;

  isCurrent = (lease: SessionLease): boolean =>
    Boolean(
      this.current &&
      !lease.signal.aborted &&
      this.current.generation === lease.generation &&
      this.current.ownerKey === lease.ownerKey &&
      this.current.token === lease.token,
    );

  readReplica = (lease: SessionLease): ReplicaState => {
    if (!this.isCurrent(lease)) throw new Error('stale');
    return structuredClone(this.replicas.get(lease.ownerKey)!);
  };

  updateReplica = async (
    lease: SessionLease,
    update: (current: ReplicaState) => ReplicaState,
  ): Promise<void> => {
    if (!this.isCurrent(lease)) throw new Error('stale');
    if (this.nextUpdateError) {
      const error = this.nextUpdateError;
      this.nextUpdateError = null;
      throw error;
    }
    this.replicas.set(lease.ownerKey, structuredClone(update(this.readReplica(lease))));
    const afterApply = this.afterNextApply;
    this.afterNextApply = null;
    afterApply?.();
    if (this.nextAppliedUpdateError) {
      const error = this.nextAppliedUpdateError;
      this.nextAppliedUpdateError = null;
      throw error;
    }
    await Promise.resolve();
    if (!this.isCurrent(lease)) throw new Error('stale');
  };

  setStatus = (lease: SessionLease, status: SyncStatus): void => {
    if (!this.isCurrent(lease)) throw new Error('stale');
    this.statuses.set(lease.ownerKey, status);
  };

  setSyncGated = (lease: SessionLease, value: boolean): void => {
    if (!this.isCurrent(lease)) throw new Error('stale');
    this.gated.set(lease.ownerKey, value);
  };

  expireSession = async (lease: SessionLease): Promise<boolean> => {
    if (!this.isCurrent(lease)) return false;
    this.expired.push(lease.token);
    this.statuses.set(lease.ownerKey, 'auth-required');
    this.signOut();
    return true;
  };
}

interface LedgerCall {
  token: string;
  method: 'register' | 'push' | 'changes';
  body?: RegisterDeviceRequest | SyncPushRequest;
  cursor?: string;
}

interface Handlers {
  register?(lease: SessionLease, body: RegisterDeviceRequest): Promise<{ activeDevices: number }>;
  push?(lease: SessionLease, body: SyncPushRequest): Promise<SyncPushResponse>;
  changes?(lease: SessionLease, cursor: string, deviceId: string): Promise<SyncChangesResponse>;
}

function harness(port: MemoryPort, handlers: Handlers = {}) {
  const calls: LedgerCall[] = [];
  const coordinator = createSyncCoordinator({
    port,
    deviceName: 'Test device',
    platform: 'test',
    now: () => '2026-07-15T12:00:00.000Z',
    apiForLease: (lease) => ({
      registerDevice: async (body) => {
        calls.push({ token: lease.token, method: 'register', body });
        return handlers.register?.(lease, body) ?? { activeDevices: 1 };
      },
      syncPush: async (body) => {
        calls.push({ token: lease.token, method: 'push', body });
        return handlers.push?.(lease, body) ?? { applied: [], conflicts: [] };
      },
      syncChanges: async (cursor, deviceId) => {
        calls.push({ token: lease.token, method: 'changes', cursor });
        return (
          handlers.changes?.(lease, cursor, deviceId) ?? {
            changes: [],
            cursor,
            hasMore: false,
          }
        );
      },
    }),
  });
  return { ...coordinator, calls };
}

describe('session-bound sync coordinator', () => {
  it('acknowledges a delayed push without dropping a newer local edit', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const sent = mutation('op-sent', 'first edit');
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica('c0'),
      deviceId: lease.deviceId,
      notes: { [noteId]: note(workspaceA, 'first edit') },
      outbox: [sent],
    });
    const push = deferred<SyncPushResponse>();
    let pushCount = 0;
    const h = harness(port, {
      push: async (_lease, body) => {
        pushCount += 1;
        expect(port.replicas.get(lease.ownerKey)?.pendingPush).toEqual(body.mutations);
        return pushCount === 1 ? push.promise : appliedPush(body);
      },
    });

    const running = h.sync();
    await vi.waitFor(() => expect(h.calls.some((call) => call.method === 'push')).toBe(true));
    const newer = mutation('op-newer', 'newest edit');
    port.replicas.set(lease.ownerKey, {
      ...port.replicas.get(lease.ownerKey)!,
      notes: { [noteId]: note(workspaceA, 'newest edit') },
      outbox: [newer],
    });
    push.resolve({
      applied: [{ opId: sent.opId, note: note(workspaceA, 'first edit', 2) }],
      conflicts: [],
    });
    await running;

    const replica = port.replicas.get(lease.ownerKey)!;
    expect(replica.notes[noteId]?.bodyMd).toBe('newest edit');
    expect(replica.notes[noteId]?.version).toBe(3);
    expect(replica.outbox).toEqual([]);
    expect(replica.pendingPush).toBeNull();
    expect(
      h.calls
        .filter((call) => call.method === 'push')
        .map((call) => (call.body as SyncPushRequest).mutations),
    ).toEqual([[sent], [{ ...newer, baseVersion: 2 }]]);
  });

  it('retries the exact staged request after a lost response and rebases a newer edit', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const sent = mutation('op-sent', 'first edit');
    const newer = mutation('op-newer', 'newest edit');
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica('c0'),
      deviceId: lease.deviceId,
      notes: { [noteId]: note(workspaceA, 'first edit') },
      outbox: [sent],
    });

    let attempts = 0;
    const h = harness(port, {
      push: async (_lease, body) => {
        attempts += 1;
        if (attempts === 1) {
          port.replicas.set(lease.ownerKey, {
            ...port.replicas.get(lease.ownerKey)!,
            notes: { [noteId]: note(workspaceA, 'newest edit') },
            outbox: [newer],
          });
          // Model a committed server transaction whose response never reached the client.
          throw new TypeError('response lost');
        }
        const applied = body.mutations[0]!;
        return {
          applied: [
            {
              opId: applied.opId,
              note: note(workspaceA, applied.note.bodyMd, applied.baseVersion + 1),
            },
          ],
          conflicts: [],
        };
      },
    });

    await h.sync();
    expect(port.statuses.get(lease.ownerKey)).toBe('offline');
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toEqual([sent]);
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([newer]);

    await h.sync();
    const pushes = h.calls
      .filter((call) => call.method === 'push')
      .map((call) => (call.body as SyncPushRequest).mutations);
    expect(pushes).toEqual([[sent], [sent], [{ ...newer, baseVersion: 2 }]]);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toBeNull();
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([]);
    expect(port.replicas.get(lease.ownerKey)?.notes[noteId]?.bodyMd).toBe('newest edit');
    expect(port.replicas.get(lease.ownerKey)?.notes[noteId]?.version).toBe(3);
  });

  it('does not dispatch when durable request staging fails', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const sent = mutation('op-sent', 'must stay local');
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes: { [noteId]: note(workspaceA, 'must stay local') },
      outbox: [sent],
    });
    const error = new Error('injected persistence failure');
    error.name = 'StatePersistenceError';
    port.nextUpdateError = error;
    const h = harness(port);

    await h.sync();

    expect(h.calls).toEqual([]);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toBeNull();
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([sent]);
    expect(port.statuses.get(lease.ownerKey)).toBe('error');
  });

  it('reconfirms a memory-only staged request before dispatch after a concurrent edit', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const sent = mutation('op-sent', 'first edit');
    const newer = mutation('op-newer', 'newest edit');
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica('c0'),
      deviceId: lease.deviceId,
      notes: { [noteId]: note(workspaceA, 'first edit') },
      outbox: [sent],
    });
    const persistenceError = new Error('staging save failed after applying memory');
    persistenceError.name = 'StatePersistenceError';
    const confirmationError = new Error('memory-only batch is not durable');
    confirmationError.name = 'StatePersistenceError';
    const h = harness(port, {
      push: async (_lease, body) => ({
        applied: body.mutations.map((item) => ({
          opId: item.opId,
          note: note(workspaceA, item.note.bodyMd, item.baseVersion + 1),
        })),
        conflicts: [],
      }),
    });
    port.nextAppliedUpdateError = persistenceError;
    port.afterNextApply = () => {
      port.replicas.set(lease.ownerKey, {
        ...port.replicas.get(lease.ownerKey)!,
        notes: { [noteId]: note(workspaceA, 'newest edit') },
        outbox: [newer],
      });
      port.nextUpdateError = confirmationError;
      void h.sync();
    };

    await h.sync();

    expect(h.calls).toEqual([]);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toEqual([sent]);
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([newer]);
    expect(port.statuses.get(lease.ownerKey)).toBe('error');

    await h.sync();

    expect(
      h.calls
        .filter((call) => call.method === 'push')
        .map((call) => (call.body as SyncPushRequest).mutations),
    ).toEqual([[sent], [{ ...newer, baseVersion: 2 }]]);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toBeNull();
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([]);
    expect(port.replicas.get(lease.ownerKey)?.notes[noteId]?.bodyMd).toBe('newest edit');
  });

  it('drains more than one durable bounded chunk in one cycle and registers once', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const notes: ReplicaState['notes'] = {};
    const queued = Array.from({ length: SYNC_PUSH_LIMIT + 1 }, (_, index) => {
      const id = `33333333-3333-4333-8333-${(index + 1).toString(16).padStart(12, '0')}`;
      notes[id] = { ...note(workspaceA, `body-${index}`), id };
      return {
        ...mutation(`op-${index}`, `body-${index}`),
        note: { ...mutation(`op-${index}`, `body-${index}`).note, id },
      };
    });
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes,
      outbox: queued,
    });
    const pendingAtDispatch: SyncMutation[][] = [];
    const h = harness(port, {
      push: async (_lease, body) => {
        pendingAtDispatch.push(port.replicas.get(lease.ownerKey)!.pendingPush!);
        return {
          applied: body.mutations.map((item) => ({
            opId: item.opId,
            note: { ...notes[item.note.id]!, version: item.baseVersion + 1 },
          })),
          conflicts: [],
        };
      },
    });

    await h.sync();

    const pushes = h.calls.filter((call) => call.method === 'push');
    expect(pushes.map((call) => (call.body as SyncPushRequest).mutations)).toEqual([
      queued.slice(0, SYNC_PUSH_LIMIT),
      [queued.at(-1)],
    ]);
    expect(pendingAtDispatch).toEqual(
      pushes.map((call) => (call.body as SyncPushRequest).mutations),
    );
    expect(h.calls.filter((call) => call.method === 'register')).toHaveLength(1);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toBeNull();
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([]);
  });

  it('yields at the finite chunk ceiling and preserves the remainder for the next cycle', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const firstCycleCapacity = SYNC_PUSH_CHUNK_LIMIT * SYNC_PUSH_LIMIT;
    const { notes, queued } = makeQueue(firstCycleCapacity + 1, 'op-ceiling');
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes,
      outbox: queued,
    });
    const h = harness(port, { push: async (_lease, body) => appliedPush(body) });

    await h.sync();

    const firstCyclePushes = h.calls
      .filter((call) => call.method === 'push')
      .map((call) => call.body as SyncPushRequest);
    expect(firstCyclePushes).toHaveLength(SYNC_PUSH_CHUNK_LIMIT);
    expect(firstCyclePushes.flatMap((body) => body.mutations)).toEqual(
      queued.slice(0, firstCycleCapacity),
    );
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toBeNull();
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual(queued.slice(firstCycleCapacity));
    expect(h.calls.filter((call) => call.method === 'register')).toHaveLength(1);

    await h.sync();

    expect(h.calls.filter((call) => call.method === 'push')).toHaveLength(
      SYNC_PUSH_CHUNK_LIMIT + 1,
    );
    expect(h.calls.filter((call) => call.method === 'register')).toHaveLength(2);
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([]);
  });

  it('does not stage or send a second chunk when the first response is invalid', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const { notes, queued } = makeQueue(SYNC_PUSH_LIMIT + 1, 'op-invalid-response');
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes,
      outbox: queued,
    });
    const h = harness(port, {
      push: () => Promise.reject(new ApiResponseValidationError('/v1/sync/push')),
    });

    await h.sync();

    const pushes = h.calls.filter((call) => call.method === 'push');
    expect(pushes).toHaveLength(1);
    expect((pushes[0]!.body as SyncPushRequest).mutations).toEqual(
      queued.slice(0, SYNC_PUSH_LIMIT),
    );
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toEqual(
      queued.slice(0, SYNC_PUSH_LIMIT),
    );
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual(queued);
    expect(port.replicas.get(lease.ownerKey)?.syncIssue).toMatchObject({
      code: 'invalid_sync_response',
      recoveryKind: 'retry',
    });
    expect(h.calls.some((call) => call.method === 'changes')).toBe(false);
  });

  it('does not stage or send a second chunk when the first response commit fails', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const { notes, queued } = makeQueue(SYNC_PUSH_LIMIT + 1, 'op-commit-failure');
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes,
      outbox: queued,
    });
    const persistenceError = new Error('first push response was not saved');
    persistenceError.name = 'StatePersistenceError';
    const h = harness(port, {
      push: async (_lease, body) => {
        port.nextUpdateError = persistenceError;
        return appliedPush(body);
      },
    });

    await h.sync();

    expect(h.calls.filter((call) => call.method === 'push')).toHaveLength(1);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toEqual(
      queued.slice(0, SYNC_PUSH_LIMIT),
    );
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual(queued);
    expect(port.replicas.get(lease.ownerKey)?.syncIssue).toBeNull();
    expect(port.statuses.get(lease.ownerKey)).toBe('error');
    expect(h.calls.some((call) => call.method === 'changes')).toBe(false);
  });

  it('preserves and drains a newer edit queued while the first chunk is in flight', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const { notes, queued } = makeQueue(SYNC_PUSH_LIMIT + 1, 'op-in-flight');
    const firstNoteId = queued[0]!.note.id;
    const newer = {
      ...mutation('op-newer-between-chunks', 'newest edit'),
      note: { ...mutation('op-newer-between-chunks', 'newest edit').note, id: firstNoteId },
    };
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes,
      outbox: queued,
    });
    let pushCount = 0;
    const h = harness(port, {
      push: async (_lease, body) => {
        pushCount += 1;
        expect(port.replicas.get(lease.ownerKey)?.pendingPush).toEqual(body.mutations);
        if (pushCount === 1) {
          const current = port.replicas.get(lease.ownerKey)!;
          port.replicas.set(lease.ownerKey, {
            ...current,
            notes: {
              ...current.notes,
              [firstNoteId]: { ...note(workspaceA, 'newest edit'), id: firstNoteId },
            },
            outbox: [...current.outbox.filter((item) => item.note.id !== firstNoteId), newer],
          });
        }
        return appliedPush(body);
      },
    });

    await h.sync();

    const pushes = h.calls
      .filter((call) => call.method === 'push')
      .map((call) => (call.body as SyncPushRequest).mutations);
    expect(pushes).toEqual([
      queued.slice(0, SYNC_PUSH_LIMIT),
      [queued.at(-1), { ...newer, baseVersion: 2 }],
    ]);
    expect(port.replicas.get(lease.ownerKey)?.notes[firstNoteId]).toMatchObject({
      bodyMd: 'newest edit',
      version: 3,
    });
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([]);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toBeNull();
    expect(h.calls.filter((call) => call.method === 'register')).toHaveLength(1);
  });

  it('stages the count cap while measuring multibyte request bytes exactly', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const notes: ReplicaState['notes'] = {};
    const bodyMd = 'é'.repeat(100_000);
    const queued = Array.from({ length: 10 }, (_, index) => {
      const id = `33333333-3333-4333-8333-${(index + 1).toString(16).padStart(12, '0')}`;
      const item = {
        ...mutation(`op-byte-${index}`, bodyMd),
        note: { ...mutation(`op-byte-${index}`, bodyMd).note, id },
      };
      notes[id] = { ...note(workspaceA, bodyMd), id };
      return item;
    });
    const expected: SyncMutation[] = [];
    for (const item of queued) {
      if (expected.length >= SYNC_PUSH_LIMIT) break;
      const candidate = { deviceId: lease.deviceId, mutations: [...expected, item] };
      if (syncPushRequestByteLength(candidate) > SYNC_PUSH_MAX_BYTES) break;
      expected.push(item);
    }
    expect(expected).toHaveLength(SYNC_PUSH_LIMIT);
    expect(expected.length).toBeLessThan(queued.length);
    expect(
      syncPushRequestByteLength({ deviceId: lease.deviceId, mutations: [queued[0]!] }),
    ).toBeGreaterThan(bodyMd.length);
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes,
      outbox: queued,
    });
    const h = harness(port, {
      push: async (_lease, body) => ({
        applied: body.mutations.map((item) => ({
          opId: item.opId,
          note: { ...notes[item.note.id]!, version: item.baseVersion + 1 },
        })),
        conflicts: [],
      }),
    });

    await h.sync();

    const pushes = h.calls
      .filter((call) => call.method === 'push')
      .map((call) => call.body as SyncPushRequest);
    const first = pushes[0]!;
    expect(first.mutations).toEqual(expected);
    for (const request of pushes) {
      expect(request.mutations.length).toBeLessThanOrEqual(SYNC_PUSH_LIMIT);
      expect(syncPushRequestByteLength(request)).toBeLessThanOrEqual(SYNC_PUSH_MAX_BYTES);
    }
    const nextCandidate = {
      deviceId: lease.deviceId,
      mutations: [...first.mutations, queued[first.mutations.length]!],
    };
    expect(nextCandidate.mutations.length).toBeGreaterThan(SYNC_PUSH_LIMIT);
    expect(syncPushRequestByteLength(nextCandidate)).toBeLessThanOrEqual(SYNC_PUSH_MAX_BYTES);
    expect(pushes.flatMap((request) => request.mutations)).toEqual(queued);
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([]);
  });

  it('creates a terminal restage issue for one oversized mutation without dispatching', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const bodyMd = '🪻'.repeat(Math.ceil(SYNC_PUSH_MAX_BYTES / 4));
    const oversized = mutation('op-oversized', bodyMd);
    expect(
      syncPushRequestByteLength({ deviceId: lease.deviceId, mutations: [oversized] }),
    ).toBeGreaterThan(SYNC_PUSH_MAX_BYTES);
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes: { [noteId]: note(workspaceA, bodyMd) },
      outbox: [oversized],
    });
    const h = harness(port);

    await h.sync();

    expect(h.calls).toEqual([]);
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([oversized]);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toBeNull();
    expect(port.replicas.get(lease.ownerKey)?.syncIssue).toMatchObject({
      code: 'sync_mutation_too_large',
      affectedOpIds: ['op-oversized'],
      recoveryKind: 'restage',
    });
  });

  it('fails loud before dispatch when a local mutation violates the wire contract', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const invalidId = 'not-a-uuid';
    const invalid = {
      ...mutation('op-invalid', 'kept locally'),
      note: { ...mutation('op-invalid', 'kept locally').note, id: invalidId },
    };
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes: { [invalidId]: { ...note(workspaceA, 'kept locally'), id: invalidId } },
      outbox: [invalid],
    });
    const h = harness(port);

    await h.sync();

    expect(h.calls).toEqual([]);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toBeNull();
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([invalid]);
    expect(port.replicas.get(lease.ownerKey)?.syncIssue).toMatchObject({
      code: 'invalid_local_sync_mutation',
      affectedOpIds: ['op-invalid'],
      recoveryKind: 'restage',
    });
    expect(port.statuses.get(lease.ownerKey)).toBe('error');
  });

  it('retains the staged request and fails loud on idempotency-key reuse', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const sent = mutation('op-reused', 'bound payload');
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica(),
      deviceId: lease.deviceId,
      notes: { [noteId]: note(workspaceA, 'bound payload') },
      outbox: [sent],
    });
    const h = harness(port, {
      push: () =>
        Promise.reject(
          new ApiRequestError(
            409,
            'idempotency_key_reused',
            'Operation id was already bound',
            undefined,
            sent.opId,
          ),
        ),
    });

    await h.sync();

    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toEqual([sent]);
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([sent]);
    expect(port.replicas.get(lease.ownerKey)?.syncIssue).toMatchObject({
      code: 'idempotency_key_reused',
      affectedOpIds: [sent.opId],
      recoveryKind: 'rekey',
    });
    expect(port.statuses.get(lease.ownerKey)).toBe('error');

    const callCount = h.calls.length;
    await h.sync();
    expect(h.calls).toHaveLength(callCount);
  });

  it('discards a delayed A push after sign-out and makes no later request', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    const sent = mutation('op-a', 'private A draft');
    port.replicas.set(lease.ownerKey, {
      ...emptyReplica('a0'),
      deviceId: lease.deviceId,
      notes: { [noteId]: note(workspaceA, 'private A draft') },
      outbox: [sent],
    });
    const push = deferred<SyncPushResponse>();
    const h = harness(port, { push: () => push.promise });

    const running = h.sync();
    await vi.waitFor(() => expect(h.calls.some((call) => call.method === 'push')).toBe(true));
    port.signOut();
    push.resolve({
      applied: [{ opId: sent.opId, note: note(workspaceA, 'landed', 2) }],
      conflicts: [],
    });
    await running;

    expect(port.current).toBeNull();
    expect(port.replicas.get(lease.ownerKey)?.outbox).toEqual([sent]);
    expect(port.replicas.get(lease.ownerKey)?.pendingPush).toEqual([sent]);
    expect(h.calls.filter((call) => call.method === 'changes')).toHaveLength(0);
    expect(new Set(h.calls.map((call) => call.token))).toEqual(new Set(['token-A']));
  });

  it('commits pull pages with cursors and preserves an edit made between pages', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    port.replicas.set(lease.ownerKey, { ...emptyReplica('c0'), deviceId: lease.deviceId });
    const second = deferred<SyncChangesResponse>();
    const h = harness(port, {
      changes: (_lease, cursor) =>
        cursor === 'c0'
          ? Promise.resolve({
              changes: [note(workspaceA, 'page one')],
              cursor: 'c1',
              hasMore: true,
            })
          : second.promise,
    });

    const running = h.sync();
    await vi.waitFor(() =>
      expect(h.calls.some((call) => call.method === 'changes' && call.cursor === 'c1')).toBe(true),
    );
    expect(port.replicas.get(lease.ownerKey)?.syncCursor).toBe('c1');
    const pending = mutation('op-local', 'local between pages');
    port.replicas.set(lease.ownerKey, {
      ...port.replicas.get(lease.ownerKey)!,
      notes: { [noteId]: note(workspaceA, 'local between pages') },
      outbox: [pending],
    });
    second.resolve({
      changes: [note(workspaceA, 'server page two', 2)],
      cursor: 'c2',
      hasMore: false,
    });
    await running;

    const replica = port.replicas.get(lease.ownerKey)!;
    expect(replica.syncCursor).toBe('c2');
    expect(replica.notes[noteId]?.bodyMd).toBe('local between pages');
    expect(replica.outbox).toEqual([pending]);
  });

  it('cannot apply an A pagination response after B becomes active', async () => {
    const port = new MemoryPort();
    const leaseA = port.adopt('A');
    port.replicas.set(leaseA.ownerKey, { ...emptyReplica('a0'), deviceId: leaseA.deviceId });
    const pageA2 = deferred<SyncChangesResponse>();
    const h = harness(port, {
      changes: (lease, cursor) => {
        if (lease.workspaceId === workspaceA) {
          return cursor === 'a0'
            ? Promise.resolve({
                changes: [note(workspaceA, 'A page one')],
                cursor: 'a1',
                hasMore: true,
              })
            : pageA2.promise;
        }
        return Promise.resolve({ changes: [], cursor: 'b1', hasMore: false });
      },
    });

    const runningA = h.sync();
    await vi.waitFor(() =>
      expect(h.calls.some((call) => call.token === 'token-A' && call.cursor === 'a1')).toBe(true),
    );
    const leaseB = port.adopt('B');
    port.replicas.set(leaseB.ownerKey, { ...emptyReplica('b0'), deviceId: leaseB.deviceId });
    const runningB = h.sync();
    pageA2.resolve({
      changes: [note(workspaceA, 'A page two')],
      cursor: 'a2',
      hasMore: false,
    });
    await Promise.all([runningA, runningB]);

    expect(port.replicas.get(leaseA.ownerKey)?.syncCursor).toBe('a1');
    expect(port.replicas.get(leaseB.ownerKey)?.notes).toEqual({});
    expect(port.replicas.get(leaseB.ownerKey)?.syncCursor).toBe('b1');
    expect(
      h.calls.some(
        (call) => call.token === 'token-B' && call.method === 'changes' && call.cursor === 'b0',
      ),
    ).toBe(true);
  });

  it.each(['register', 'push', 'pull'] as const)(
    'expires the current session when %s returns 401 and stops the cycle',
    async (stage) => {
      const port = new MemoryPort();
      const lease = port.adopt('A');
      if (stage !== 'register') {
        const op = mutation('op-a', 'A');
        port.replicas.set(lease.ownerKey, {
          ...emptyReplica('a0'),
          deviceId: lease.deviceId,
          notes: { [noteId]: note(workspaceA, 'A') },
          outbox: stage === 'push' ? [op] : [],
        });
      }
      const unauthorized = () =>
        Promise.reject(new ApiRequestError(401, 'unauthorized', 'Authentication required'));
      const h = harness(port, {
        register: stage === 'register' ? unauthorized : undefined,
        push: stage === 'push' ? unauthorized : undefined,
        changes: stage === 'pull' ? unauthorized : undefined,
      });

      await h.sync();

      expect(port.current).toBeNull();
      expect(port.expired).toEqual(['token-A']);
      if (stage === 'register') {
        expect(h.calls.map((call) => call.method)).toEqual(['register']);
      } else if (stage === 'push') {
        expect(h.calls.map((call) => call.method)).toEqual(['register', 'push']);
      }
    },
  );

  it('ignores a late A 401 instead of signing B out', async () => {
    const port = new MemoryPort();
    const leaseA = port.adopt('A');
    const op = mutation('op-a', 'A');
    port.replicas.set(leaseA.ownerKey, {
      ...emptyReplica(),
      deviceId: leaseA.deviceId,
      notes: { [noteId]: note(workspaceA, 'A') },
      outbox: [op],
    });
    const push = deferred<SyncPushResponse>();
    const h = harness(port, { push: () => push.promise });
    const running = h.sync();
    await vi.waitFor(() => expect(h.calls.some((call) => call.method === 'push')).toBe(true));

    const leaseB = port.adopt('B');
    push.reject(new ApiRequestError(401, 'unauthorized', 'Expired A token'));
    await running;

    expect(port.current?.ownerKey).toBe(leaseB.ownerKey);
    expect(port.expired).toEqual([]);
  });

  it('never sends A outbox data with B token', async () => {
    const port = new MemoryPort();
    const leaseA = port.adopt('A');
    const opA = mutation('op-a', 'A private draft');
    port.replicas.set(leaseA.ownerKey, {
      ...emptyReplica('a0'),
      deviceId: leaseA.deviceId,
      notes: { [noteId]: note(workspaceA, 'A private draft') },
      outbox: [opA],
      pendingPush: [opA],
    });
    const leaseB = port.adopt('B');
    port.replicas.set(leaseB.ownerKey, { ...emptyReplica('b0'), deviceId: leaseB.deviceId });
    const h = harness(port);

    await h.sync();
    expect(
      h.calls.some(
        (call) =>
          call.token === 'token-B' &&
          call.method === 'push' &&
          (call.body as SyncPushRequest).mutations.some((item) => item.opId === opA.opId),
      ),
    ).toBe(false);

    port.adopt('A', 'token-A-new');
    await h.sync();
    const aPush = h.calls.find((call) => call.token === 'token-A-new' && call.method === 'push');
    expect((aPush?.body as SyncPushRequest).mutations).toEqual([opA]);
  });

  it('keeps cursors isolated across account switches', async () => {
    const port = new MemoryPort();
    const leaseA = port.adopt('A');
    port.replicas.set(leaseA.ownerKey, { ...emptyReplica('cursor-A'), deviceId: leaseA.deviceId });
    const leaseB = port.adopt('B');
    port.replicas.set(leaseB.ownerKey, { ...emptyReplica('cursor-B'), deviceId: leaseB.deviceId });
    const h = harness(port, {
      changes: (lease) =>
        Promise.resolve({
          changes: [],
          cursor: lease.workspaceId === workspaceA ? 'cursor-A2' : 'cursor-B2',
          hasMore: false,
        }),
    });

    await h.sync();
    port.adopt('A', 'token-A2');
    await h.sync();

    expect(h.calls.some((call) => call.token === 'token-B' && call.cursor === 'cursor-B')).toBe(
      true,
    );
    expect(h.calls.some((call) => call.token === 'token-A2' && call.cursor === 'cursor-A')).toBe(
      true,
    );
    expect(port.replicas.get(leaseA.ownerKey)?.syncCursor).toBe('cursor-A2');
    expect(port.replicas.get(leaseB.ownerKey)?.syncCursor).toBe('cursor-B2');
  });

  it('fails closed on a cross-workspace response', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('B');
    port.replicas.set(lease.ownerKey, { ...emptyReplica('b0'), deviceId: lease.deviceId });
    const h = harness(port, {
      changes: () =>
        Promise.resolve({
          changes: [note(workspaceA, 'must not cross')],
          cursor: 'b1',
          hasMore: false,
        }),
    });

    await h.sync();

    expect(port.replicas.get(lease.ownerKey)?.notes).toEqual({});
    expect(port.replicas.get(lease.ownerKey)?.syncCursor).toBe('b0');
    expect(port.replicas.get(lease.ownerKey)?.syncIssue).toMatchObject({
      code: 'sync_workspace_mismatch',
      recoveryKind: 'retry',
    });
    expect(port.statuses.get(lease.ownerKey)).toBe('error');
  });

  it('does not apply a stalled page and reports a protocol error', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    port.replicas.set(lease.ownerKey, { ...emptyReplica('stuck'), deviceId: lease.deviceId });
    const h = harness(port, {
      changes: () =>
        Promise.resolve({
          changes: [note(workspaceA, 'must not apply')],
          cursor: 'stuck',
          hasMore: true,
        }),
    });

    await h.sync();

    expect(port.replicas.get(lease.ownerKey)?.notes).toEqual({});
    expect(port.replicas.get(lease.ownerKey)?.syncIssue).toMatchObject({
      code: 'sync_protocol_error',
      recoveryKind: 'retry',
    });
    expect(port.statuses.get(lease.ownerKey)).toBe('error');
  });

  it('persists malformed successful responses and invalid cursors with actionable recovery', async () => {
    const responsePort = new MemoryPort();
    const responseLease = responsePort.adopt('A');
    const malformed = harness(responsePort, {
      changes: () => Promise.reject(new ApiResponseValidationError('/v1/sync/changes')),
    });

    await malformed.sync();
    expect(responsePort.replicas.get(responseLease.ownerKey)?.syncIssue).toMatchObject({
      code: 'invalid_sync_response',
      recoveryKind: 'retry',
    });
    const heldCallCount = malformed.calls.length;
    await malformed.sync();
    expect(malformed.calls).toHaveLength(heldCallCount);

    const cursorPort = new MemoryPort();
    const cursorLease = cursorPort.adopt('A');
    cursorPort.replicas.set(cursorLease.ownerKey, {
      ...emptyReplica('bad-cursor'),
      deviceId: cursorLease.deviceId,
    });
    const invalidCursor = harness(cursorPort, {
      changes: () =>
        Promise.reject(new ApiRequestError(400, 'invalid_sync_cursor', 'Cursor is invalid')),
    });

    await invalidCursor.sync();
    expect(cursorPort.replicas.get(cursorLease.ownerKey)?.syncCursor).toBe('bad-cursor');
    expect(cursorPort.replicas.get(cursorLease.ownerKey)?.syncIssue).toMatchObject({
      code: 'invalid_sync_cursor',
      affectedOpIds: [],
      recoveryKind: 'reset-cursor',
    });
  });

  it('keeps billing, network, and authentication failures distinct', async () => {
    const paymentPort = new MemoryPort();
    const paymentLease = paymentPort.adopt('A');
    const payment = harness(paymentPort, {
      register: () => Promise.reject(new ApiRequestError(402, 'payment_required', 'Device limit')),
    });
    await payment.sync();
    expect(paymentPort.current?.ownerKey).toBe(paymentLease.ownerKey);
    expect(paymentPort.gated.get(paymentLease.ownerKey)).toBe(true);
    expect(paymentPort.statuses.get(paymentLease.ownerKey)).toBe('idle');

    const offlinePort = new MemoryPort();
    const offlineLease = offlinePort.adopt('A');
    const offline = harness(offlinePort, {
      register: () => Promise.reject(new TypeError('network down')),
    });
    await offline.sync();
    expect(offlinePort.current?.ownerKey).toBe(offlineLease.ownerKey);
    expect(offlinePort.statuses.get(offlineLease.ownerKey)).toBe('offline');
    expect(offlinePort.expired).toEqual([]);
  });

  it('leaves transient client errors retryable without creating a durable hold', async () => {
    const port = new MemoryPort();
    const lease = port.adopt('A');
    let attempts = 0;
    const h = harness(port, {
      register: async () => {
        attempts += 1;
        if (attempts === 1) throw new ApiRequestError(429, 'rate_limited', 'Try again');
        return { activeDevices: 1 };
      },
    });

    await h.sync();
    expect(port.statuses.get(lease.ownerKey)).toBe('offline');
    expect(port.replicas.get(lease.ownerKey)?.syncIssue).toBeNull();

    await h.sync();
    expect(attempts).toBe(2);
    expect(port.statuses.get(lease.ownerKey)).toBe('idle');
  });
});
