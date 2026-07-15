/**
 * Auth provider seam (ADR-004). The foundation ships `LocalAuthProvider`; a
 * `ClerkAuthProvider` / `SupabaseAuthProvider` implements the same interface and is
 * selected by `AUTH_PROVIDER`. Password reset / OAuth / email verification are the
 * managed provider's job — deliberately NOT built into the local one.
 */
import type { AgentScope } from '@iris/shared';
import type { Database } from '../db/client';

/** The authenticated identity behind a request — a human user OR an agent. */
export interface Principal {
  type: 'user' | 'agent';
  /** user id, or agent-token id */
  id: string;
  /** display name, or agent name — used verbatim in the activity log */
  name: string;
  workspaceId: string;
  /** Users implicitly hold every scope; agents hold exactly what their token grants. */
  scopes: AgentScope[];
}

export interface AuthedUser {
  userId: string;
  workspaceId: string;
  email: string;
  displayName: string;
}

export interface AuthProvider {
  readonly name: string;
  /**
   * Create a user + their personal workspace + membership + free subscription row.
   * Returns the session identity. This is the tenant-provisioning entry point.
   */
  signUp(db: Database, input: { email: string; password: string; displayName: string }): Promise<AuthedUser>;
  /** Verify credentials and return the session identity, or throw HttpError(401). */
  signIn(db: Database, input: { email: string; password: string }): Promise<AuthedUser>;
}
