/**
 * Account deletion (plan A5, audit #7). Irreversible, operator-only erasure of a whole
 * workspace and its owner — the App Store (Guideline 5.1.1(v)) and GDPR Art. 17 / CCPA
 * both require an in-product path to this. Export (GET /v1/export) is offered first in the
 * UI; this endpoint performs the actual erasure.
 *
 * Integrity notes (sync-resilience milestone):
 * - Confirmation email must match before any mutation.
 * - The workspace sync lock is acquired before erase so an in-flight push cannot interleave
 *   partial note writes with cascade deletion.
 * - Stripe cancellation remains best-effort (human-gated durable reconciliation design);
 *   failures emit a privacy-safe structured diagnostic before identifiers are erased.
 */
import { eq, sql } from 'drizzle-orm';
import type { DeleteAccountRequest, DeleteAccountResponse } from '@iris/shared';
import { subscriptions, users, workspaces, workspaceSyncCursors } from '../db/schema';
import type { Ctx } from '../context';
import { badRequest } from '../lib/errors';
import { billingGateway } from './stripe';

/**
 * Structured, privacy-safe diagnostics for account deletion. Never includes tokens,
 * note bodies, passwords, or raw emails — only opaque ids needed for operator reconciliation.
 */
export type AccountDeletionDiagnostic = {
  event:
    | 'account_deletion_billing_cancel_failed'
    | 'account_deletion_completed'
    | 'account_deletion_unconfirmed';
  workspaceId: string;
  userId: string;
  /** True when a provider subscription id was present at cancel time. */
  stripeSubscriptionPresent: boolean;
  /**
   * Last 4 characters of the Stripe subscription id for out-of-band correlation when cancel
   * fails. Omitted when no id was present. Never the full secret-bearing credential.
   */
  stripeSubscriptionIdSuffix?: string;
};

type DiagnosticSink = (event: AccountDeletionDiagnostic) => void;

const diagnosticListeners: DiagnosticSink[] = [];

/** Test/operator hook: observe privacy-safe deletion diagnostics without reading logs. */
export function onAccountDeletionDiagnostic(listener: DiagnosticSink): () => void {
  diagnosticListeners.push(listener);
  return () => {
    const index = diagnosticListeners.indexOf(listener);
    if (index >= 0) diagnosticListeners.splice(index, 1);
  };
}

export function emitAccountDeletionDiagnostic(event: AccountDeletionDiagnostic): void {
  for (const listener of diagnosticListeners) {
    try {
      listener(event);
    } catch {
      // Diagnostics must never block or reverse erasure.
    }
  }
}

function subscriptionSuffix(id: string): string {
  return id.length <= 4 ? id : id.slice(-4);
}

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
    emitAccountDeletionDiagnostic({
      event: 'account_deletion_unconfirmed',
      workspaceId: ctx.workspaceId,
      userId: ctx.principal.id,
      stripeSubscriptionPresent: false,
    });
    throw badRequest('Type your account email to confirm deletion', 'account_deletion_unconfirmed');
  }

  // Serialize against in-flight sync pushes for this workspace. Push acquires the same
  // workspace_sync_cursors row lock before claiming receipts or mutating notes; holding it
  // here means either the push commits first (then cascade erases its writes) or delete
  // commits first (then the waiting push observes a missing workspace/device and fails closed).
  await ctx.db
    .insert(workspaceSyncCursors)
    .values({ workspaceId: ctx.workspaceId, lastSeq: 0n })
    .onConflictDoUpdate({
      target: workspaceSyncCursors.workspaceId,
      set: { lastSeq: sql`${workspaceSyncCursors.lastSeq}` },
    });

  // Stop billing first so a deleted account is never charged again. Best-effort: a provider
  // failure must NOT block erasure (GDPR gives the user the right regardless), but a dangling
  // live subscription then needs manual follow-up. Emit a privacy-safe diagnostic so operators
  // can reconcile before the subscription row is cascade-deleted.
  const [sub] = await ctx.db
    .select({ stripeSubscriptionId: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, ctx.workspaceId));
  const stripeId = sub?.stripeSubscriptionId ?? null;
  if (stripeId) {
    try {
      await billingGateway().cancelSubscription(stripeId);
    } catch {
      emitAccountDeletionDiagnostic({
        event: 'account_deletion_billing_cancel_failed',
        workspaceId: ctx.workspaceId,
        userId: ctx.principal.id,
        stripeSubscriptionPresent: true,
        stripeSubscriptionIdSuffix: subscriptionSuffix(stripeId),
      });
      // Intentionally swallowed — erasure proceeds; the orphaned provider sub is reconciled
      // out of band (durable cancellation design remains human-gated, plan A5).
    }
  }

  // Erase everything. Deleting the workspace cascades every tenant table (each FK is
  // ON DELETE CASCADE, and referential cascades bypass RLS), then remove the now-orphaned
  // auth-bootstrap user row. Both run in this request's single tenant transaction.
  await ctx.db.delete(workspaces).where(eq(workspaces.id, ctx.workspaceId));
  await ctx.db.delete(users).where(eq(users.id, ctx.principal.id));

  emitAccountDeletionDiagnostic({
    event: 'account_deletion_completed',
    workspaceId: ctx.workspaceId,
    userId: ctx.principal.id,
    stripeSubscriptionPresent: Boolean(stripeId),
    stripeSubscriptionIdSuffix: stripeId ? subscriptionSuffix(stripeId) : undefined,
  });

  return { deleted: true };
}
