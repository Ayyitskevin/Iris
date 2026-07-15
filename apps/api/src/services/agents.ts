/**
 * Agent-token service (ADR-009). A token is `iris_at_<tokenId>_<secret>`: the id lets
 * us look the row up in O(1); only a scrypt hash of the secret is stored, so a leaked
 * database never yields usable tokens. Tokens are scoped and revocable.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AgentScope, IssueAgentTokenResponse } from '@iris/shared';
import { agentTokens } from '../db/schema';
import type { Database } from '../db/client';
import type { Ctx } from '../context';
import { notFound } from '../lib/errors';
import { hashSecret, verifySecret } from '../lib/hash';
import { newId, newSecret } from '../lib/ids';
import { serializeAgentToken } from '../serialize';

const TOKEN_PREFIX = 'iris_at_';

function formatToken(tokenId: string, secret: string): string {
  return `${TOKEN_PREFIX}${tokenId}_${secret}`;
}

export function isAgentToken(presented: string): boolean {
  return presented.startsWith(TOKEN_PREFIX);
}

export async function issueAgentToken(
  ctx: Ctx,
  input: { agentName: string; scopes: AgentScope[] },
): Promise<IssueAgentTokenResponse> {
  const tokenId = newId();
  const secret = newSecret();
  const tokenHash = await hashSecret(secret);
  const token = formatToken(tokenId, secret);

  const inserted = await ctx.db
    .insert(agentTokens)
    .values({
      id: tokenId,
      workspaceId: ctx.workspaceId,
      agentName: input.agentName,
      tokenHash,
      // Cosmetic display hint; never enough to reconstruct the token.
      tokenPrefix: `${TOKEN_PREFIX}${tokenId.slice(0, 8)}…`,
      scopes: input.scopes,
    })
    .returning();

  return { token, agentToken: serializeAgentToken(inserted[0]!) };
}

export async function listAgentTokens(ctx: Ctx) {
  const rows = await ctx.db
    .select()
    .from(agentTokens)
    .where(eq(agentTokens.workspaceId, ctx.workspaceId))
    .orderBy(desc(agentTokens.createdAt));
  return rows.map(serializeAgentToken);
}

export async function revokeAgentToken(ctx: Ctx, id: string): Promise<void> {
  const updated = await ctx.db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentTokens.id, id),
        eq(agentTokens.workspaceId, ctx.workspaceId),
        isNull(agentTokens.revokedAt),
      ),
    )
    .returning({ id: agentTokens.id });
  if (updated.length === 0) throw notFound('Token not found or already revoked');
}

export interface VerifiedAgent {
  tokenId: string;
  workspaceId: string;
  agentName: string;
  scopes: AgentScope[];
}

/**
 * Authenticate a presented agent token against the store. Runs on the base db
 * (pre-tenant) — agent_tokens is not under RLS precisely so this lookup works before
 * we know the workspace (see migration note). Returns null on any failure.
 */
export async function verifyAgentToken(
  db: Database,
  presented: string,
): Promise<VerifiedAgent | null> {
  if (!isAgentToken(presented)) return null;
  const rest = presented.slice(TOKEN_PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep <= 0) return null;
  const tokenId = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);

  const rows = await db
    .select()
    .from(agentTokens)
    .where(and(eq(agentTokens.id, tokenId), isNull(agentTokens.revokedAt)));
  const row = rows[0];
  if (!row) return null;

  const ok = await verifySecret(secret, row.tokenHash);
  if (!ok) return null;

  // Best-effort last-used stamp; failure here must not block a valid request.
  try {
    await db.update(agentTokens).set({ lastUsedAt: new Date() }).where(eq(agentTokens.id, tokenId));
  } catch {
    // ignore
  }

  return {
    tokenId: row.id,
    workspaceId: row.workspaceId,
    agentName: row.agentName,
    scopes: row.scopes,
  };
}
