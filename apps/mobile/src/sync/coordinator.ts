import {
  ApiResponseValidationError,
  ApiRequestError,
  SYNC_PUSH_LIMIT,
  SYNC_PUSH_MAX_BYTES,
  SyncPushChunkRequest as SyncPushChunkRequestSchema,
  syncPushRequestByteLength,
  type ApiClient,
  type Note,
  type SyncChangesResponse,
  type SyncMutation,
} from '@iris/shared';
import type {
  ReplicaState,
  SessionLease,
  SyncIssue,
  SyncIssueRecoveryKind,
  SyncStatus,
} from '../state/store';
import { drainChangePages, reconcilePush, SyncProtocolError } from './reconcile';

type SyncApi = Pick<ApiClient, 'registerDevice' | 'syncPush' | 'syncChanges'>;

/**
 * Defensive work ceiling for one coordinator cycle. At the protocol's six-mutation
 * request limit this drains at most 96 mutations before yielding to pull/scheduling.
 */
export const SYNC_PUSH_CHUNK_LIMIT = 16;

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

function assertOwnedSyncQueues(replica: ReplicaState, lease: SessionLease): void {
  for (const mutation of [...replica.outbox, ...(replica.pendingPush ?? [])]) {
    const note = replica.notes[mutation.note.id];
    if (!note || note.workspaceId !== lease.workspaceId) {
      throw new WorkspaceResponseError('Sync queue is not owned by the active workspace');
    }
  }
}

function issue(
  code: string,
  message: string,
  affectedOpIds: string[],
  recoveryKind: SyncIssueRecoveryKind = 'retry',
): SyncIssue {
  return {
    code,
    message,
    affectedOpIds: [...new Set(affectedOpIds)],
    recoveryKind,
  };
}

function pendingOperationIds(replica: ReplicaState): string[] {
  return (replica.pendingPush ?? []).map((mutation) => mutation.opId);
}

function stagePendingPush(replica: ReplicaState, deviceId: string): ReplicaState {
  if (replica.pendingPush || replica.syncIssue || replica.outbox.length === 0) return replica;

  const mutations: SyncMutation[] = [];
  for (const mutation of replica.outbox) {
    if (mutations.length >= SYNC_PUSH_LIMIT) break;

    const singleRequest = { deviceId, mutations: [mutation] };
    if (syncPushRequestByteLength(singleRequest) > SYNC_PUSH_MAX_BYTES) {
      return {
        ...replica,
        syncIssue: issue(
          'sync_mutation_too_large',
          'One pending note is too large to fit in a sync request. Edit it to a smaller size, then retry.',
          [mutation.opId],
          'restage',
        ),
      };
    }

    const candidate = { deviceId, mutations: [...mutations, mutation] };
    if (syncPushRequestByteLength(candidate) > SYNC_PUSH_MAX_BYTES) break;

    const parsed = SyncPushChunkRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ...replica,
        syncIssue: issue(
          'invalid_local_sync_mutation',
          'A pending local change does not satisfy the sync protocol. Edit the note, then retry.',
          candidate.mutations.map((item) => item.opId),
          'restage',
        ),
      };
    }
    mutations.push(mutation);
  }

  if (mutations.length === 0) {
    return {
      ...replica,
      syncIssue: issue(
        'invalid_local_sync_mutation',
        'The pending sync queue could not be staged safely.',
        [replica.outbox[0]!.opId],
        'restage',
      ),
    };
  }
  return { ...replica, pendingPush: mutations };
}

function validatePendingPush(replica: ReplicaState, deviceId: string): SyncIssue | null {
  if (!replica.pendingPush) return null;
  const request = { deviceId, mutations: replica.pendingPush };
  if (syncPushRequestByteLength(request) > SYNC_PUSH_MAX_BYTES) {
    return issue(
      'sync_mutation_too_large',
      'The durable pending request is larger than the current sync limit. Edit the affected note, then retry.',
      pendingOperationIds(replica),
      'restage',
    );
  }
  if (!SyncPushChunkRequestSchema.safeParse(request).success) {
    return issue(
      'invalid_local_sync_mutation',
      'The durable pending request does not satisfy the current sync protocol.',
      pendingOperationIds(replica),
      'restage',
    );
  }
  return null;
}

function terminalIssueFor(error: unknown, replica: ReplicaState): SyncIssue | null {
  const pending = pendingOperationIds(replica);
  if (error instanceof ApiResponseValidationError) {
    return issue(
      'invalid_sync_response',
      'Iris received a malformed successful sync response. Retry after the service is healthy.',
      pending,
    );
  }
  if (error instanceof WorkspaceResponseError) {
    return issue('sync_workspace_mismatch', error.message, pending);
  }
  if (error instanceof SyncProtocolError) {
    return issue('sync_protocol_error', error.message, pending);
  }
  if (
    error instanceof ApiRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 402, 408, 425, 429].includes(error.status)
  ) {
    const recoveryKind: SyncIssueRecoveryKind =
      error.code === 'idempotency_key_reused'
        ? 'rekey'
        : error.code === 'invalid_sync_cursor'
          ? 'reset-cursor'
          : 'retry';
    const affectedOpIds =
      recoveryKind === 'rekey' && error.operationId ? [error.operationId] : pending;
    return issue(error.code, error.message, affectedOpIds, recoveryKind);
  }
  return null;
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
      // A 401 belongs to the exact bearer used for this request. Let the expiry boundary compare
      // that credential even when recovery invalidated the operation lease in the meantime.
      if (!(error instanceof ApiRequestError && error.status === 401)) ensureCurrent(lease);
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

  async function preparePendingPush(
    lease: SessionLease,
    confirmExistingPending: boolean,
  ): Promise<ReplicaState> {
    let replica = deps.port.readReplica(lease);
    assertOwnedSyncQueues(replica, lease);

    if (confirmExistingPending && replica.pendingPush) {
      // A failed save can leave a staged request visible in memory when a concurrent
      // edit prevents the store from rolling that projection back. Queue an exact
      // no-op commit behind every earlier save before trusting an existing batch:
      // dispatch is allowed only after this replica snapshot is durably confirmed.
      await commit(lease, (current) => {
        assertOwnedSyncQueues(current, lease);
        return current;
      });
      replica = deps.port.readReplica(lease);
      assertOwnedSyncQueues(replica, lease);
    }

    if (!replica.pendingPush && replica.outbox.length > 0) {
      // Persist the exact request before any network dispatch. A lost response or
      // process restart must retry these operation ids and payloads even if newer
      // edits replace outbox.
      await commit(lease, (current) => {
        assertOwnedSyncQueues(current, lease);
        return stagePendingPush(current, lease.deviceId);
      });
      replica = deps.port.readReplica(lease);
      assertOwnedSyncQueues(replica, lease);
    }

    if (replica.syncIssue) return replica;

    const invalidPendingPush = validatePendingPush(replica, lease.deviceId);
    if (invalidPendingPush) {
      await commit(lease, (current) => ({
        ...current,
        syncIssue: current.syncIssue ?? invalidPendingPush,
      }));
      replica = deps.port.readReplica(lease);
    }
    return replica;
  }

  async function runCycle(lease: SessionLease): Promise<void> {
    const api = deps.apiForLease(lease);
    try {
      const initialReplica = deps.port.readReplica(lease);
      if (initialReplica.syncIssue) {
        deps.port.setStatus(lease, 'error');
        return;
      }
      deps.port.setStatus(lease, 'syncing');

      let beforePush = await preparePendingPush(lease, true);
      if (beforePush.syncIssue) {
        deps.port.setStatus(lease, 'error');
        return;
      }

      await request(lease, () =>
        api.registerDevice({
          id: lease.deviceId,
          name: deps.deviceName,
          platform: deps.platform,
        }),
      );
      deps.port.setSyncGated(lease, false);

      for (let chunkIndex = 0; chunkIndex < SYNC_PUSH_CHUNK_LIMIT; chunkIndex += 1) {
        if (chunkIndex > 0) {
          // The previous response has been validated, reconciled, and durably saved
          // with pendingPush:null before another exact request may be staged.
          beforePush = await preparePendingPush(lease, false);
          if (beforePush.syncIssue) {
            deps.port.setStatus(lease, 'error');
            return;
          }
        }

        const sent: SyncMutation[] = [...(beforePush.pendingPush ?? [])];
        if (sent.length === 0) break;

        const body = { deviceId: lease.deviceId, mutations: sent };
        const response = await request(lease, () => api.syncPush(body));
        for (const applied of response.applied) {
          if (applied.note) assertWorkspaceNote(applied.note, lease);
        }
        for (const conflict of response.conflicts) {
          assertWorkspaceNote(conflict.serverNote, lease);
        }
        await commit(lease, (current) => ({
          ...current,
          ...reconcilePush(current, sent, response, deps.now()),
          pendingPush: null,
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
      if (error instanceof ApiRequestError && error.status === 401) {
        try {
          await deps.port.expireSession(lease);
        } catch {
          // The store is already fail-closed and owns durable retry scheduling.
        }
        return;
      }
      if (!deps.port.isCurrent(lease) || error instanceof StaleSyncCycleError) return;
      if (error instanceof ApiRequestError && error.isPaymentRequired) {
        deps.port.setSyncGated(lease, true);
        deps.port.setStatus(lease, 'idle');
        return;
      }
      let currentReplica: ReplicaState;
      try {
        currentReplica = deps.port.readReplica(lease);
      } catch {
        deps.port.setStatus(lease, 'error');
        return;
      }
      const terminalIssue = terminalIssueFor(error, currentReplica);
      if (terminalIssue) {
        try {
          await commit(lease, (current) => ({
            ...current,
            syncIssue: current.syncIssue ?? terminalIssue,
          }));
        } catch {
          // Durable storage failures remain retryable; do not claim a hold was saved.
        }
        deps.port.setStatus(lease, 'error');
        return;
      }
      if (
        error instanceof Error &&
        ['ReplicaCommitSupersededError', 'ReplicaIntegrityError', 'StatePersistenceError'].includes(
          error.name,
        )
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
