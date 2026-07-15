import type { AuthResponse } from '@iris/shared';
import { api } from '../api';
import { saveState, store$ } from '../state/store';

async function adopt(res: AuthResponse): Promise<void> {
  store$.session.set({
    token: res.token,
    userId: res.user.id,
    workspaceId: res.workspace.id,
    email: res.user.email,
    displayName: res.user.displayName,
  });
  await saveState();
}

export async function signIn(email: string, password: string): Promise<void> {
  await adopt(await api.signIn({ email, password }));
}

export async function signUp(email: string, password: string, displayName: string): Promise<void> {
  await adopt(await api.signUp({ email, password, displayName }));
}

export async function signOut(): Promise<void> {
  store$.session.set(null);
  store$.notes.set({});
  store$.outbox.set([]);
  store$.syncCursor.set('');
  store$.syncGated.set(false);
  store$.conflictNoteId.set(null);
  await saveState();
}
