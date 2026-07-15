import { createApiClient } from '@iris/shared';
import { API_URL } from './config';
import { store$ } from './state/store';

/** The shared, typed API client, bound to the current session token. */
export const api = createApiClient({
  baseUrl: API_URL,
  getToken: () => store$.session.get()?.token ?? null,
});
