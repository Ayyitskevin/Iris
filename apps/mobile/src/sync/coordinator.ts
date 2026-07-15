import {
  ApiRequestError,
  type ApiClient,
  type Note,
  type SyncChangesResponse,
  type SyncMutation,
} from '@iris/shared';
import type { ReplicaState, SessionLease, SyncStatus } from '../state/store';
import { drainChangePages, reconcilePush, SyncProtocolError } from './reconcile';

type SyncApi = Pick<ApiClient, 'registerDevice' | 'syncPush' | 'syncChanges'>;

export interface SyncPort {
  captureLease(): SessionLease | null;
  isCurrent(lease: SessionLease): boolean;
  readReplica(lease: SessionLease): ReplicaState;
  updateReplica(
    lease: SessionLease,
    update: (current: ReplicaState) => ReplicaState,
  ): Promise<void>;
  setStatus(lease: SessionLease, status: SyncStatus): void;
  setSyncGated(lease: SessionLease, gated: boolean): void;
  expireSession(lease: SessionLease): Promise<boolean>;
}

export interface SyncCoordinatorDependencies {
  port: SyncPort;
  apiForLease(lease: SessionLease): SyncApi;
  deviceName: string;
  platform: string;
  now(): string;
}

class StaleSyncCycleError extends Error {
  constructor() {
    super('Sync cycle no longer owns the active session');
    this.name = 'StaleSyncCycleError';
  }
}

export class WorkspaceResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceResponseError';
  }
}

function assertWorkspaceNote(note: Note, lease: SessionLease): void {
  if (note.workspaceId !== lease.workspaceId) {
    throw new WorkspaceResponseError('Sync response contained a note from another workspace');
  }
}

function assertOwnedOutbox(replica: ReplicaState, lease: SessionLease): void {
  for (const mutation of replica.outbox) {
    const note = replica.notes[mutation.note.id];
    if (!note || note.workspaceId !== lease.workspaceId) {
      throw new WorkspaceResponseError('Sync outbox is not owned by the active workspace');
    }
  }
}

export function createSyncCoordinator(deps: SyncCoordinatorDependencies): {
  sync(): Promise<void>;
} {
  const activeRuns = new Map<number, { again: boolean; promise: Promise<void> }>();

  function ensureCurrent(lease: SessionLease): void {
    if (!deps.port.isCurrent(lease)) throw new StaleSyncCycleError();
  }

  async function request<T>(lease: SessionLease, operation: () => Promise<T>): Promise<T> {
    ensureCurrent(lease);
    try {
      const value = await operation();
      ensureCurrent(lease);
      return value;
    } catch (error) {
      ensureCurrent(lease);
      throw error;
    }
  }

  async function commit(
    lease: SessionLease,
    update: (current: ReplicaState) => ReplicaState,
  ): Promise<void> {
    ensureCurrent(lease);
    await deps.port.updateReplica(lease, update);
    ensureCurrent(lease);
  }

  async function runCycle(lease: SessionLease): Promise<void> {
    const api = deps.apiForLease(lease);
    try {
      deps.port.setStatus(lease, 'syncing');

      await request(lease, () =>
        api.registerDevice({
          id: lease.deviceId,
          name: deps.deviceName,
          platform: deps.platform,
        }),
      );
      deps.port.setSyncGated(lease, false);

      const beforePush = deps.port.readReplica(lease);
      assertOwnedOutbox(beforePush, lease);
      const sent: SyncMutation[] = [...beforePush.outbox];
      if (sent.length > 0) {
        const response = await request(lease, () =>
          api.syncPush({ deviceId: lease.deviceId, mutations: sent }),
        );
        for (const applied of response.applied) {
          if (applied.note) assertWorkspaceNote(applied.note, lease);
        }
        for (const conflict of response.conflicts) {
          assertWorkspaceNote(conflict.serverNote, lease);
        }
        await commit(lease, (current) => ({
          ...current,
          ...reconcilePush(current, sent, response, deps.now()),
        }));
      }

      const initialCursor = deps.port.readReplica(lease).syncCursor;
      await drainChangePages(
        initialCursor,
        (cursor) => request(lease, () => api.syncChanges(cursor, lease.deviceId)),
        async (page: SyncChangesResponse) => {
          for (const note of page.changes) assertWorkspaceNote(note, lease);
          await commit(lease, (current) => {
            const notes = { ...current.notes };
            const conflicts = { ...current.conflicts };
            const pending = new Set(current.outbox.map((mutation) => mutation.note.id));
            for (const note of page.changes) {
              if (pending.has(note.id)) continue;
              const conflict = conflicts[note.id];
              if (conflict) conflicts[note.id] = { ...conflict, serverNote: note };
              notes[note.id] = note;
            }
            return { ...current, notes, conflicts, syncCursor: page.cursor };
          });
        },
      );

      ensureCurrent(lease);
      deps.port.setStatus(lease, 'idle');
    } catch (error) {
      if (!deps.port.isCurrent(lease) || error instanceof StaleSyncCycleError) return;
      if (error instanceof ApiRequestError && error.status === 401) {
        try {
          await deps.port.expireSession(lease);
        } catch {
          // The store is already fail-closed and owns durable retry scheduling.
        }
        return;
      }
      if (error instanceof ApiRequestError && error.isPaymentRequired) {
        deps.port.setSyncGated(lease, true);
        deps.port.setStatus(lease, 'idle');
        return;
      }
      if (
        error instanceof WorkspaceResponseError ||
        error instanceof SyncProtocolError ||
        (error instanceof Error &&
          ['ReplicaIntegrityError', 'StatePersistenceError'].includes(error.name))
      ) {
        deps.port.setStatus(lease, 'error');
        return;
      }
      deps.port.setStatus(lease, 'offline');
    }
  }

  function sync(): Promise<void> {
    const firstLease = deps.port.captureLease();
    if (!firstLease) return Promise.resolve();
    const existing = activeRuns.get(firstLease.generation);
    if (existing) {
      existing.again = true;
      return existing.promise;
    }

    const run = { again: false, promise: Promise.resolve() };
    run.promise = (async () => {
      do {
        run.again = false;
        const lease = deps.port.captureLease();
        if (!lease || lease.generation !== firstLease.generation) return;
        await runCycle(lease);
      } while (run.again && deps.port.isCurrent(firstLease));
    })().finally(() => {
      if (activeRuns.get(firstLease.generation) === run) {
        activeRuns.delete(firstLease.generation);
      }
    });
    activeRuns.set(firstLease.generation, run);
    return run.promise;
  }

  return { sync };
}
