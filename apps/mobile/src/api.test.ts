import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));
vi.mock('./state/storage', () => ({
  storage: {
    get: async (key: string) => memory.values.get(key) ?? null,
    set: async (key: string, value: string) => {
      memory.values.set(key, value);
    },
    remove: async (key: string) => {
      memory.values.delete(key);
    },
  },
}));

import { apiForLease, authenticatedRequest } from './api';
import { adoptSession, loadState, openSessionLease, store$, type Session } from './state/store';

const sessionA: Session = {
  token: 'fixed-token-A',
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'a@example.com',
  displayName: 'A',
};
const sessionB: Session = {
  token: 'fixed-token-B',
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'b@example.com',
  displayName: 'B',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  memory.values.clear();
  vi.restoreAllMocks();
  await loadState();
  await adoptSession(sessionA);
});

describe('fixed-token authenticated API boundary', () => {
  it('sends A token and discards its delayed response after B adoption', async () => {
    const leaseA = openSessionLease()!;
    const response = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => response.promise);
    const request = apiForLease(leaseA).billingStatus();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    await adoptSession(sessionB);
    response.resolve(
      new Response(
        JSON.stringify({
          plan: 'free',
          status: 'none',
          activeDevices: 1,
          deviceLimit: 1,
        }),
        { status: 200 },
      ),
    );

    await expect(request).rejects.toThrow('Session changed');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixed-token-A');
    expect(store$.session.get()).toEqual(sessionB);
  });

  it('rejects a stale lease before dispatching another request', async () => {
    const leaseA = openSessionLease()!;
    const clientA = apiForLease(leaseA);
    await adoptSession(sessionB);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(clientA.billingStatus()).rejects.toThrow('Session changed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('expires only the current session after a 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'unauthorized', message: 'Expired' },
        }),
        { status: 401 },
      ),
    );

    await expect(authenticatedRequest((api) => api.billingStatus())).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(store$.session.get()).toBeNull();
    expect(store$.status.get()).toBe('auth-required');
  });
});
