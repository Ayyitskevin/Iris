import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import type { Database } from '../db/client';
import { verifySession } from '../auth/jwt';
import type { Principal } from '../auth/provider';
import { isAgentToken, verifyAgentToken } from '../services/agents';
import { unauthorized } from '../lib/errors';

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

/**
 * Resolve the principal behind a request from its Authorization header. Two credential
 * types, one identity model (Principal): an agent token (`iris_at_…`) or a user session
 * JWT. Both carry a single workspaceId — the tenant boundary (ADR-003).
 */
export async function resolvePrincipal(
  db: Database,
  authHeader: string | undefined,
): Promise<Principal> {
  const token = extractBearer(authHeader);
  if (!token) throw unauthorized();

  if (isAgentToken(token)) {
    const agent = await verifyAgentToken(db, token);
    if (!agent) throw unauthorized('Invalid or revoked agent token');
    return {
      type: 'agent',
      id: agent.tokenId,
      name: agent.agentName,
      workspaceId: agent.workspaceId,
      scopes: agent.scopes,
    };
  }

  let claims;
  try {
    claims = await verifySession(token);
  } catch {
    throw unauthorized('Invalid or expired session');
  }
  const rows = await db.select().from(users).where(eq(users.id, claims.sub));
  const user = rows[0];
  if (!user) throw unauthorized('Session user no longer exists');
  return {
    type: 'user',
    id: user.id,
    name: user.displayName,
    workspaceId: claims.wid,
    // Users implicitly hold every scope within their workspace.
    scopes: ['notes:read', 'notes:write'],
  };
}
