/**
 * The local-first engine (ADR-005). Local mutations apply to the observable store
 * *instantly* and enqueue an outbox entry; `sync()` reconciles with the server:
 * register the device (billing gate), push the outbox (surfacing conflicts), then pull
 * deltas. Nothing here blocks the UI.
 */
import { ApiRequestError, type Note, type SyncMutation } from '@iris/shared';
import { Platform } from 'react-native';
import { api } from '../api';
import { saveState, store$ } from '../state/store';

function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return g.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Replace any pending mutation for the same note so the outbox stays small. */
function enqueue(mutation: SyncMutation): void {
  const rest = store$.outbox.get().filter((m) => m.note.id !== mutation.note.id);
  store$.outbox.set([...rest, mutation]);
  void saveState();
  void sync();
}

// ── Local mutations (optimistic) ─────────────────────────────────────────────

export function createNoteLocal(input: { title: string; bodyMd: string; folder?: string | null }): Note {
  const session = store$.session.get();
  const id = uuid();
  const note: Note = {
    id,
    workspaceId: session?.workspaceId ?? 'local',
    title: input.title,
    bodyMd: input.bodyMd,
    folder: input.folder ?? null,
    version: 0, // 0 => created locally, not yet acknowledged by the server
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
  store$.notes[id].set(note);
  enqueue({
    opId: uuid(),
    type: 'upsert',
    note: { id, title: note.title, bodyMd: note.bodyMd, folder: note.folder },
    baseVersion: 0,
  });
  return note;
}

export function updateNoteLocal(id: string, patch: { title?: string; bodyMd?: string; folder?: string | null }): void {
  const current = store$.notes[id].get();
  if (!current) return;
  const next: Note = {
    ...current,
    title: patch.title ?? current.title,
    bodyMd: patch.bodyMd ?? current.bodyMd,
    folder: patch.folder === undefined ? current.folder : patch.folder,
    updatedAt: nowIso(),
  };
  store$.notes[id].set(next);
  enqueue({
    opId: uuid(),
    type: 'upsert',
    note: { id, title: next.title, bodyMd: next.bodyMd, folder: next.folder },
    baseVersion: current.version,
  });
}

export function deleteNoteLocal(id: string): void {
  const current = store$.notes[id].get();
  if (!current) return;
  store$.notes[id].set({ ...current, deletedAt: nowIso() });
  enqueue({
    opId: uuid(),
    type: 'delete',
    note: { id, title: current.title, bodyMd: current.bodyMd, folder: current.folder },
    baseVersion: current.version,
  });
}

// ── Reconcile ────────────────────────────────────────────────────────────────

let syncing = false;

export async function sync(): Promise<void> {
  const session = store$.session.get();
  if (!session || syncing) return;
  syncing = true;
  store$.status.set('syncing');

  try {
    const deviceId = store$.deviceId.get();

    // Register this device — where the multi-device gate bites (ADR-007).
    try {
      await api.registerDevice({ id: deviceId, name: deviceName(), platform: Platform.OS });
      store$.syncGated.set(false);
    } catch (err) {
      if (err instanceof ApiRequestError && err.isPaymentRequired) {
        store$.syncGated.set(true);
        store$.status.set('idle');
        return; // local edits still work; sync is gated until they subscribe
      }
      throw err;
    }

    // Push the outbox.
    const outbox = store$.outbox.get();
    if (outbox.length > 0) {
      const res = await api.syncPush({ deviceId, mutations: outbox });
      for (const applied of res.applied) {
        if (applied.note) store$.notes[applied.note.id].set(applied.note);
      }
      for (const c of res.conflicts) {
        // Surface — never silently drop. Take server state; the user re-applies.
        store$.notes[c.serverNote.id].set(c.serverNote);
        store$.conflictNoteId.set(c.serverNote.id);
      }
      store$.outbox.set([]);
    }

    // Pull deltas, preserving any still-pending local edits.
    const pending = new Set(store$.outbox.get().map((m) => m.note.id));
    const changes = await api.syncChanges(store$.syncCursor.get(), deviceId);
    for (const note of changes.changes) {
      if (!pending.has(note.id)) store$.notes[note.id].set(note);
    }
    store$.syncCursor.set(changes.cursor);

    store$.status.set('idle');
    await saveState();
  } catch {
    store$.status.set('offline');
  } finally {
    syncing = false;
  }
}

function deviceName(): string {
  if (Platform.OS === 'web') return 'Web session';
  return `${Platform.OS} device`;
}
