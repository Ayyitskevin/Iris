import { env } from '../env';
import { localAuthProvider } from './local-provider';
import type { AuthProvider } from './provider';

/**
 * Select the auth provider. Only `local` is implemented; `clerk`/`supabase` are
 * documented seams (ADR-004) — implement the AuthProvider interface and wire here.
 */
export function getAuthProvider(): AuthProvider {
  switch (env.authProvider) {
    case 'local':
      return localAuthProvider;
    case 'clerk':
    case 'supabase':
      throw new Error(
        `AUTH_PROVIDER=${env.authProvider} is a documented seam but not implemented in the foundation. ` +
          `Implement the AuthProvider interface and register it in src/auth/index.ts.`,
      );
    default:
      return localAuthProvider;
  }
}

export * from './provider';
