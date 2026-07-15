import type { AuthResponse } from '@iris/shared';
import { publicApi } from '../api';
import { adoptSession, signOutSession } from '../state/store';
import { sync } from '../sync/manager';

async function adopt(res: AuthResponse): Promise<void> {
  await adoptSession({
    token: res.token,
    userId: res.user.id,
    workspaceId: res.workspace.id,
    email: res.user.email,
    displayName: res.user.displayName,
  });
  void sync();
}

export async function signIn(email: string, password: string): Promise<void> {
  await adopt(await publicApi.signIn({ email, password }));
}

export async function signUp(email: string, password: string, displayName: string): Promise<void> {
  await adopt(await publicApi.signUp({ email, password, displayName }));
}

export async function signOut(): Promise<void> {
  await signOutSession();
}
