import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthResponse } from '@iris/shared';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  adoptSession: vi.fn(),
  signOutSession: vi.fn(),
  scheduleSync: vi.fn(),
}));

vi.mock('../api', () => ({
  publicApi: { signIn: mocks.signIn, signUp: mocks.signUp },
}));
vi.mock('../state/store', () => ({
  adoptSession: mocks.adoptSession,
  signOutSession: mocks.signOutSession,
}));
vi.mock('../sync/manager', () => ({ scheduleSync: mocks.scheduleSync }));

import { signIn, signOut, signUp } from './session';

const response: AuthResponse = {
  token: 'token-A',
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'operator@example.com',
    displayName: 'Operator',
    createdAt: '2026-07-19T12:00:00.000Z',
  },
  workspace: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: "Operator's workspace",
    createdAt: '2026-07-19T12:00:00.000Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signIn.mockResolvedValue(response);
  mocks.signUp.mockResolvedValue(response);
  mocks.adoptSession.mockResolvedValue(undefined);
  mocks.signOutSession.mockResolvedValue(undefined);
});

describe('authenticated session transitions', () => {
  it('adopts sign-in state before sending one lifecycle-gated sync intent', async () => {
    const order: string[] = [];
    mocks.adoptSession.mockImplementation(async () => {
      order.push('adopt');
    });
    mocks.scheduleSync.mockImplementation(() => {
      order.push('schedule');
    });

    await signIn('operator@example.com', 'password123');

    expect(mocks.signIn).toHaveBeenCalledWith({
      email: 'operator@example.com',
      password: 'password123',
    });
    expect(mocks.adoptSession).toHaveBeenCalledWith({
      token: response.token,
      userId: response.user.id,
      workspaceId: response.workspace.id,
      email: response.user.email,
      displayName: response.user.displayName,
    });
    expect(mocks.scheduleSync).toHaveBeenCalledWith('immediate');
    expect(order).toEqual(['adopt', 'schedule']);
  });

  it('routes sign-up through the same post-adoption scheduler boundary', async () => {
    await signUp('operator@example.com', 'password123', 'Operator');

    expect(mocks.signUp).toHaveBeenCalledWith({
      email: 'operator@example.com',
      password: 'password123',
      displayName: 'Operator',
    });
    expect(mocks.adoptSession).toHaveBeenCalledOnce();
    expect(mocks.scheduleSync).toHaveBeenCalledOnce();
    expect(mocks.scheduleSync).toHaveBeenCalledWith('immediate');
  });

  it('keeps sign-out local and does not create a network scheduling intent', async () => {
    await signOut();

    expect(mocks.signOutSession).toHaveBeenCalledOnce();
    expect(mocks.scheduleSync).not.toHaveBeenCalled();
  });
});
