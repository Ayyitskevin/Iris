/**
 * The local-first store (ADR-005). A Legend-State observable is the single source of
 * truth the UI renders; edits mutate it synchronously so the app never waits on the
 * network. A background sync manager reconciles it with the server. An outbox holds
 * mutations made offline until they're pushed.
 */
import { observable } from '@legendapp/state';
import type { Note, SyncMutation } from '@iris/shared';
import { storage } from './storage';

export interface Session {
  token: string;
  userId: string;
  workspaceId: string;
  email: string;
  displayName: string;
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface AppState {
  session: Session | null;
  /** Local-first note cache — the UI's source of truth (ADR-005). */
  notes: Record<string, Note>;
  syncCursor: string;
  deviceId: string;
  /** Mutations made locally, awaiting push. Survives restarts (offline-first). */
  outbox: SyncMutation[];
  status: SyncStatus;
  /** True when sync is blocked by the multi-device billing gate (ADR-007). */
  syncGated: boolean;
  /** Set when the server rejected a push as a conflict, so the UI can surface it. */
  conflictNoteId: string | null;
}

export const store$ = observable<AppState>({
  session: null,
  notes: {},
  syncCursor: '',
  deviceId: '',
  outbox: [],
  status: 'idle',
  syncGated: false,
  conflictNoteId: null,
});

const STATE_KEY = 'iris:state:v1';

interface Persisted {
  session: Session | null;
  notes: Record<string, Note>;
  syncCursor: string;
  deviceId: string;
  outbox: SyncMutation[];
}

/** Load persisted state on boot so the app opens instantly, offline. */
export async function loadState(): Promise<void> {
  const raw = await storage.get(STATE_KEY);
  let deviceId = '';
  if (raw) {
    try {
      const p = JSON.parse(raw) as Persisted;
      store$.session.set(p.session ?? null);
      store$.notes.set(p.notes ?? {});
      store$.syncCursor.set(p.syncCursor ?? '');
      store$.outbox.set(p.outbox ?? []);
      deviceId = p.deviceId ?? '';
    } catch {
      // corrupt cache — start fresh
    }
  }
  if (!deviceId) deviceId = generateDeviceId();
  store$.deviceId.set(deviceId);
}

/** Persist the durable slice. Best-effort: on native, large blobs may exceed the
 * SecureStore limit — that's fine, the ROADMAP notes a native DB for durable notes. */
export async function saveState(): Promise<void> {
  const p: Persisted = {
    session: store$.session.get(),
    notes: store$.notes.get(),
    syncCursor: store$.syncCursor.get(),
    deviceId: store$.deviceId.get(),
    outbox: store$.outbox.get(),
  };
  try {
    await storage.set(STATE_KEY, JSON.stringify(p));
  } catch {
    // ignore persistence failures (e.g., SecureStore size cap on native)
  }
}

function generateDeviceId(): string {
  // Stable per install. crypto.randomUUID exists on web + Hermes; fall back if not.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `device-${g.crypto.randomUUID()}`;
  return `device-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** Sorted, non-deleted notes for list rendering. */
export function selectVisibleNotes(): Note[] {
  return Object.values(store$.notes.get())
    .filter((n) => !n.deletedAt)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Distinct tags across visible notes, with counts — powers the filter chips. */
export function selectTags(): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of selectVisibleNotes()) {
    for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
