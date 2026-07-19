import type { Note, SyncMutation } from '@iris/shared';
import type { SyncConflictDraft } from '../sync/reconcile';

export interface ReplicaIntegritySyncIssue {
  code: string;
  message: string;
  affectedOpIds: string[];
  recoveryKind: 'rekey' | 'reset-cursor' | 'restage' | 'retry';
}

export interface ReplicaIntegrityCandidate {
  version: number;
  ownerKey: string;
  userId: string;
  workspaceId: string;
  notes: Record<string, Note>;
  syncCursor: string;
  deviceId: string;
  outbox: SyncMutation[];
  pendingPush: SyncMutation[] | null;
  syncIssue: ReplicaIntegritySyncIssue | null;
  conflicts: Record<string, SyncConflictDraft>;
}

export class ReplicaIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplicaIntegrityError';
  }
}

/** Durable v1 operation identity, without applying server wire-content limits to local notes. */
export function isValidReplicaOperationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes('\u0000')
  );
}

function sameReplicaOperation(left: SyncMutation, right: SyncMutation): boolean {
  return (
    left.opId === right.opId &&
    left.type === right.type &&
    left.baseVersion === right.baseVersion &&
    left.note.id === right.note.id &&
    left.note.title === right.note.title &&
    left.note.bodyMd === right.note.bodyMd &&
    left.note.folder === right.note.folder &&
    left.note.tags.length === right.note.tags.length &&
    left.note.tags.every((tag, index) => tag === right.note.tags[index])
  );
}

/**
 * Cross-cutting semantic invariants for every credential-free owner root.
 *
 * Storage-specific parsers remain responsible for their exact wire shape. This shared leaf
 * prevents the active store and recovery journal from disagreeing about whether a parsed root
 * is safe to project, summarize, or export.
 */
export function assertReplicaSemanticIntegrity(replica: ReplicaIntegrityCandidate): void {
  if (
    replica.version !== 2 ||
    replica.ownerKey !== replica.workspaceId + '.' + replica.userId ||
    !replica.deviceId
  ) {
    throw new ReplicaIntegrityError('Replica owner metadata is invalid');
  }

  for (const [id, note] of Object.entries(replica.notes)) {
    if (id !== note.id || note.workspaceId !== replica.workspaceId) {
      throw new ReplicaIntegrityError('Replica contains a note owned by another workspace');
    }
  }
  if (replica.pendingPush !== null && !Array.isArray(replica.pendingPush)) {
    throw new ReplicaIntegrityError('Replica pending push is invalid');
  }
  if (replica.pendingPush?.length === 0) {
    throw new ReplicaIntegrityError('Replica pending push cannot be empty');
  }
  if (replica.syncIssue !== null) {
    const issue = replica.syncIssue;
    if (
      !issue ||
      typeof issue !== 'object' ||
      typeof issue.code !== 'string' ||
      issue.code.length === 0 ||
      typeof issue.message !== 'string' ||
      issue.message.length === 0 ||
      !Array.isArray(issue.affectedOpIds) ||
      issue.affectedOpIds.some((opId) => typeof opId !== 'string' || opId.length === 0) ||
      new Set(issue.affectedOpIds).size !== issue.affectedOpIds.length ||
      !['rekey', 'reset-cursor', 'restage', 'retry'].includes(issue.recoveryKind)
    ) {
      throw new ReplicaIntegrityError('Replica sync issue is invalid');
    }
  }
  for (const queue of [replica.outbox, replica.pendingPush ?? []]) {
    const operationIds = new Set<string>();
    for (const mutation of queue) {
      if (!isValidReplicaOperationId(mutation.opId) || operationIds.has(mutation.opId)) {
        throw new ReplicaIntegrityError('Replica sync queue contains an invalid operation');
      }
      operationIds.add(mutation.opId);
      const note = replica.notes[mutation.note.id];
      if (!note || note.workspaceId !== replica.workspaceId) {
        throw new ReplicaIntegrityError('Replica sync queue is not backed by an owned note');
      }
    }
  }
  const outboxByOperationId = new Map(
    replica.outbox.map((mutation) => [mutation.opId, mutation] as const),
  );
  for (const pending of replica.pendingPush ?? []) {
    const queued = outboxByOperationId.get(pending.opId);
    if (queued && !sameReplicaOperation(queued, pending)) {
      throw new ReplicaIntegrityError(
        'Replica sync queues reuse an operation id with a different payload',
      );
    }
  }
  for (const [id, conflict] of Object.entries(replica.conflicts)) {
    if (
      id !== conflict.noteId ||
      conflict.serverNote.id !== id ||
      conflict.serverNote.workspaceId !== replica.workspaceId ||
      conflict.localMutation.note.id !== id
    ) {
      throw new ReplicaIntegrityError('Replica conflict is not owned by this workspace');
    }
  }
}
