import { describe, expect, it, vi } from 'vitest';
import {
  ApiRequestError,
  type RegisterDeviceRequest,
  type SyncChangesResponse,
  type SyncMutation,
  type SyncPushRequest,
  type SyncPushResponse,
} from '@iris/shared';
import type { ReplicaState, SessionLease, SyncStatus } from '../state/store';
import { createSyncCoordinator, type SyncPort } from './coordinator';

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

function emptyReplica(cursor = ''): ReplicaState {
  return {
    notes: {},
    syncCursor: cursor,
    deviceId: '',
    outbox: [],
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
    this.replicas.set(lease.ownerKey, structuredClone(update(this.readReplica(lease))));
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
    const h = harness(port, { push: () => push.promise });

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
    expect(replica.outbox).toEqual([{ ...newer, baseVersion: 2 }]);
    const pushCall = h.calls.find((call) => call.method === 'push')!;
    expect((pushCall.body as SyncPushRequest).mutations).toEqual([sent]);
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
    expect(port.statuses.get(lease.ownerKey)).toBe('error');
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
});
