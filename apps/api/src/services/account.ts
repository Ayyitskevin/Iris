/**
 * Account deletion (plan A5, audit #7). Irreversible, operator-only erasure of a whole
 * workspace and its owner — the App Store (Guideline 5.1.1(v)) and GDPR Art. 17 / CCPA
 * both require an in-product path to this. Export (GET /v1/export) is offered first in the
 * UI; this endpoint performs the actual erasure.
 */
import { eq } from 'drizzle-orm';
import type { DeleteAccountRequest, DeleteAccountResponse } from '@iris/shared';
import { subscriptions, users, workspaces } from '../db/schema';
import type { Ctx } from '../context';
import { badRequest } from '../lib/errors';
import { billingGateway } from './stripe';

export async function deleteAccount(
  ctx: Ctx,
  input: DeleteAccountRequest,
): Promise<DeleteAccountResponse> {
  // Confirm intent: the caller must echo their own email. Blocks accidental taps and a
  // CSRF-style forced deletion (an attacker with a stolen token still needs the email).
  const [owner] = await ctx.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, ctx.principal.id));
  if (!owner) throw badRequest('Account not found', 'account_not_found');
  if (input.confirmEmail.trim().toLowerCase() !== owner.email.toLowerCase()) {
    throw badRequest('Type your account email to confirm deletion', 'account_deletion_unconfirmed');
  }

  // Stop billing first so a deleted account is never charged again. Best-effort: a provider
  // failure must NOT block erasure (GDPR gives the user the right regardless), but a dangling
  // live subscription then needs manual follow-up.
  const [sub] = await ctx.db
    .select({ stripeSubscriptionId: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, ctx.workspaceId));
  if (sub?.stripeSubscriptionId) {
    try {
      await billingGateway().cancelSubscription(sub.stripeSubscriptionId);
    } catch {
      // Intentionally swallowed — erasure proceeds; the orphaned provider sub is reconciled
      // out of band.
    }
  }

  // Erase everything. Deleting the workspace cascades every tenant table (each FK is
  // ON DELETE CASCADE, and referential cascades bypass RLS), then remove the now-orphaned
  // auth-bootstrap user row. Both run in this request's single tenant transaction.
  await ctx.db.delete(workspaces).where(eq(workspaces.id, ctx.workspaceId));
  await ctx.db.delete(users).where(eq(users.id, ctx.principal.id));

  return { deleted: true };
}
