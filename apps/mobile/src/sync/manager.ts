/**
 * Local mutations are synchronous; network reconciliation is delegated to a coordinator
 * that owns one immutable session/workspace lease per cycle.
 */
import type { Note, SyncMutation } from '@iris/shared';
import { Platform } from 'react-native';
import { apiForLease } from '../api';
import {
  assertCurrentSession,
  expireSessionIfCurrent,
  isCurrentSession,
  openSessionLease,
  readReplicaForLease,
  saveState,
  setStatusForLease,
  setSyncGatedForLease,
  store$,
  updateReplicaForLease,
  type SessionLease,
} from '../state/store';
import { createSyncCoordinator } from './coordinator';

function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();

  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function currentLease(): SessionLease {
  const lease = openSessionLease();
  if (!lease) throw new Error('Authentication required');
  return lease;
}

function deviceName(): string {
  if (Platform.OS === 'web') return 'Web session';
  return Platform.OS + ' device';
}

const coordinator = createSyncCoordinator({
  port: {
    captureLease: openSessionLease,
    isCurrent: isCurrentSession,
    readReplica: readReplicaForLease,
    updateReplica: updateReplicaForLease,
    setStatus: setStatusForLease,
    setSyncGated: setSyncGatedForLease,
    expireSession: expireSessionIfCurrent,
  },
  apiForLease,
  deviceName: deviceName(),
  platform: Platform.OS,
  now: nowIso,
});

export function sync(): Promise<void> {
  return coordinator.sync();
}

/**
 * Apply the durable recovery encoded by the active owner's sync issue, then start one
 * fresh cycle. Pending payloads are preserved exactly except for deliberate op-id rekeys.
 */
export async function recoverSyncIssue(): Promise<boolean> {
  const lease = currentLease();
  if (!store$.syncIssue.get()) return true;

  try {
    await updateReplicaForLease(lease, (current) => {
      const issue = current.syncIssue;
      if (!issue) return current;

      if (issue.recoveryKind === 'rekey') {
        const pendingPush = current.pendingPush;
        if (!pendingPush) return { ...current, syncIssue: null };

        const targetIds = new Set(
          issue.affectedOpIds.length > 0
            ? issue.affectedOpIds
            : pendingPush.map((mutation) => mutation.opId),
        );
        const replacements = new Map<string, string>();
        const rekeyedPending = pendingPush.map((mutation) => {
          if (!targetIds.has(mutation.opId)) return mutation;
          const replacement = uuid();
          replacements.set(mutation.opId, replacement);
          return { ...mutation, opId: replacement };
        });
        const rekeyedOutbox = current.outbox.map((mutation) => {
          const replacement = replacements.get(mutation.opId);
          return replacement ? { ...mutation, opId: replacement } : mutation;
        });
        return {
          ...current,
          pendingPush: rekeyedPending,
          outbox: rekeyedOutbox,
          syncIssue: null,
        };
      }

      if (issue.recoveryKind === 'restage') {
        return { ...current, pendingPush: null, syncIssue: null };
      }

      return {
        ...current,
        syncCursor: issue.recoveryKind === 'reset-cursor' ? '' : current.syncCursor,
        syncIssue: null,
      };
    });
    void sync();
    return true;
  } catch {
    if (isCurrentSession(lease)) setStatusForLease(lease, 'error');
    return false;
  }
}

function enqueue(lease: SessionLease, mutation: SyncMutation): void {
  assertCurrentSession(lease);
  const currentOutbox = store$.outbox.get();
  const replaced = currentOutbox.find((item) => item.note.id === mutation.note.id);
  const alreadyStaged = Boolean(
    replaced && store$.pendingPush.get()?.some((item) => item.opId === replaced.opId),
  );
  // Preserve an explicit, not-yet-dispatched resurrection while collapsing subsequent
  // edits into its newest payload. Once that resurrection is staged, later edits are a
  // separate upsert that reconciliation rebases onto the revived authoritative head.
  const nextMutation: SyncMutation =
    mutation.type === 'upsert' && replaced?.type === 'resurrect' && !alreadyStaged
      ? { ...mutation, type: 'resurrect', baseVersion: replaced.baseVersion }
      : mutation;
  const rest = currentOutbox.filter((item) => item.note.id !== mutation.note.id);
  store$.outbox.set([...rest, nextMutation]);
  void saveState();
  void sync();
}

type NotePatch = {
  title?: string;
  bodyMd?: string;
  folder?: string | null;
  tags?: string[];
};

export function createNoteLocal(input: {
  title: string;
  bodyMd: string;
  folder?: string | null;
  tags?: string[];
}): Note {
  const lease = currentLease();
  const id = uuid();
  const createdAt = nowIso();
  const note: Note = {
    id,
    workspaceId: lease.workspaceId,
    title: input.title,
    bodyMd: input.bodyMd,
    folder: input.folder ?? null,
    tags: input.tags ?? [],
    version: 0,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  assertCurrentSession(lease);
  store$.notes[id].set(note);
  enqueue(lease, {
    opId: uuid(),
    type: 'upsert',
    note: {
      id,
      title: note.title,
      bodyMd: note.bodyMd,
      folder: note.folder,
      tags: note.tags,
    },
    baseVersion: 0,
  });
  return note;
}

export function updateNoteLocal(id: string, patch: NotePatch): boolean {
  const lease = currentLease();
  if (store$.conflicts.get()[id]) return false;
  const current = store$.notes[id].get();
  if (!current || current.workspaceId !== lease.workspaceId || current.deletedAt) return false;
  const next: Note = {
    ...current,
    title: patch.title ?? current.title,
    bodyMd: patch.bodyMd ?? current.bodyMd,
    folder: patch.folder === undefined ? current.folder : patch.folder,
    tags: patch.tags ?? current.tags,
    updatedAt: nowIso(),
  };
  assertCurrentSession(lease);
  store$.notes[id].set(next);
  enqueue(lease, {
    opId: uuid(),
    type: 'upsert',
    note: {
      id,
      title: next.title,
      bodyMd: next.bodyMd,
      folder: next.folder,
      tags: next.tags,
    },
    baseVersion: current.version,
  });
  return true;
}

export function deleteNoteLocal(id: string): boolean {
  const lease = currentLease();
  if (store$.conflicts.get()[id]) return false;
  const current = store$.notes[id].get();
  if (!current || current.workspaceId !== lease.workspaceId || current.deletedAt) return false;
  assertCurrentSession(lease);
  store$.notes[id].set({ ...current, deletedAt: nowIso() });
  enqueue(lease, {
    opId: uuid(),
    type: 'delete',
    note: {
      id,
      title: current.title,
      bodyMd: current.bodyMd,
      folder: current.folder,
      tags: current.tags,
    },
    baseVersion: current.version,
  });
  return true;
}

/** Re-queue the exact retained local draft the operator reviewed. */
export async function keepLocalConflict(
  expectedOwnerKey: string,
  noteId: string,
  expectedOpId: string,
): Promise<boolean> {
  const lease = currentLease();
  if (lease.ownerKey !== expectedOwnerKey) return false;
  const conflict = store$.conflicts.get()[noteId];
  if (!conflict || conflict.localMutation.opId !== expectedOpId) return false;

  const reviewedType: SyncMutation['type'] =
    conflict.localMutation.type === 'delete'
      ? 'delete'
      : conflict.serverNote.deletedAt
        ? 'resurrect'
        : 'upsert';
  const mutation: SyncMutation = {
    ...conflict.localMutation,
    opId: uuid(),
    type: reviewedType,
    baseVersion: conflict.serverNote.version,
  };
  const local: Note = {
    ...conflict.serverNote,
    title: mutation.note.title,
    bodyMd: mutation.note.bodyMd,
    folder: mutation.note.folder,
    tags: mutation.note.tags,
    updatedAt: nowIso(),
    deletedAt: mutation.type === 'delete' ? nowIso() : null,
  };
  try {
    await updateReplicaForLease(lease, (current) => {
      const conflicts = { ...current.conflicts };
      delete conflicts[noteId];
      const rest = current.outbox.filter((item) => item.note.id !== noteId);
      return {
        ...current,
        notes: { ...current.notes, [noteId]: local },
        outbox: [...rest, mutation],
        conflicts,
      };
    });
    void sync();
    return true;
  } catch {
    if (isCurrentSession(lease)) setStatusForLease(lease, 'error');
    return false;
  }
}

/** Accept the exact server head the operator reviewed. */
export async function useServerConflict(
  expectedOwnerKey: string,
  noteId: string,
  expectedOpId: string,
): Promise<boolean> {
  const lease = currentLease();
  if (lease.ownerKey !== expectedOwnerKey) return false;
  const conflict = store$.conflicts.get()[noteId];
  if (!conflict || conflict.localMutation.opId !== expectedOpId) return false;
  try {
    await updateReplicaForLease(lease, (current) => {
      const conflicts = { ...current.conflicts };
      delete conflicts[noteId];
      return {
        ...current,
        notes: { ...current.notes, [noteId]: conflict.serverNote },
        conflicts,
      };
    });
    return true;
  } catch {
    if (isCurrentSession(lease)) setStatusForLease(lease, 'error');
    return false;
  }
}
