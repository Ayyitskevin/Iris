import { ApiRequestError, createApiClient, type ApiClient } from '@iris/shared';
import { API_URL } from './config';
import {
  assertCurrentSession,
  expireSessionIfCurrent,
  openSessionLease,
  type SessionLease,
} from './state/store';

/** Authentication endpoints never inherit a previously active bearer credential. */
export const publicApi = createApiClient({ baseUrl: API_URL });

/** A fixed-token client whose fetches are aborted and rejected when its owner changes. */
export function apiForLease(lease: SessionLease): ApiClient {
  const guardedFetch: typeof fetch = async (input, init) => {
    assertCurrentSession(lease);
    const response = await globalThis.fetch(input, { ...init, signal: lease.signal });
    assertCurrentSession(lease);
    return response;
  };
  return createApiClient({
    baseUrl: API_URL,
    getToken: () => lease.token,
    fetch: guardedFetch,
  });
}

export interface AuthenticatedResult<T> {
  lease: SessionLease;
  value: T;
}

/**
 * Run one authenticated operation under an immutable lease. Callers that mutate local
 * component or replica state must assert the returned lease immediately before doing so.
 */
export async function authenticatedRequest<T>(
  request: (client: ApiClient, lease: SessionLease) => Promise<T>,
): Promise<AuthenticatedResult<T>> {
  const lease = openSessionLease();
  if (!lease) throw new Error('Authentication required');
  try {
    assertCurrentSession(lease);
    const value = await request(apiForLease(lease), lease);
    assertCurrentSession(lease);
    return { lease, value };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      await expireSessionIfCurrent(lease);
    }
    throw error;
  }
}
