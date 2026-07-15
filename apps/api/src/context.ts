import type { AgentScope } from '@iris/shared';
import type { Database } from './db/client';
import type { Principal } from './auth/provider';
import { forbidden } from './lib/errors';

/**
 * Per-request context handed to every service. `workspaceId` is the tenant boundary;
 * services must filter every query by it (ADR-003). It is derived from the
 * authenticated principal and cannot be chosen by the caller.
 */
export interface Ctx {
  db: Database;
  principal: Principal;
  workspaceId: string;
}

/** Throw 403 unless the principal holds the given scope (users hold all scopes). */
export function requireScope(ctx: Ctx, scope: AgentScope): void {
  if (!ctx.principal.scopes.includes(scope)) {
    throw forbidden(`This token lacks the required scope: ${scope}`);
  }
}
