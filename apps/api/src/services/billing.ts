/**
 * Subscription state + the multi-device gate math (ADR-007). Free plan = 1 syncing
 * device; the ~$5/mo "sync" plan lifts that. Local use is always free — the gate is
 * purely about how many devices may reconcile.
 */
import { count, eq } from 'drizzle-orm';
import type { BillingStatus, Plan, SubscriptionStatus } from '@iris/shared';
import { devices, subscriptions, users } from '../db/schema';
import type { Database } from '../db/client';
import type { Ctx } from '../context';
import { withWorkspace } from '../db/client';
import { billingGateway, type SubscriptionEvent } from './stripe';

const FREE_DEVICE_LIMIT = 1;
const SYNC_DEVICE_LIMIT = 100;

export function deviceLimit(plan: Plan, status: SubscriptionStatus): number {
  const paidActive = plan === 'sync' && (status === 'active' || status === 'trialing');
  return paidActive ? SYNC_DEVICE_LIMIT : FREE_DEVICE_LIMIT;
}

export async function getSubscription(
  ctx: Ctx,
): Promise<{ plan: Plan; status: SubscriptionStatus }> {
  const rows = await ctx.db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, ctx.workspaceId));
  const row = rows[0];
  return {
    plan: (row?.plan as Plan) ?? 'free',
    status: (row?.status as SubscriptionStatus) ?? 'none',
  };
}

export async function countDevices(ctx: Ctx): Promise<number> {
  const rows = await ctx.db
    .select({ n: count() })
    .from(devices)
    .where(eq(devices.workspaceId, ctx.workspaceId));
  return Number(rows[0]?.n ?? 0);
}

export async function billingStatus(ctx: Ctx): Promise<BillingStatus> {
  const { plan, status } = await getSubscription(ctx);
  const limit = deviceLimit(plan, status);
  const active = await countDevices(ctx);
  return {
    plan,
    status,
    deviceLimit: limit,
    activeDevices: active,
    canSyncAnotherDevice: active < limit,
  };
}

export async function createCheckout(ctx: Ctx): Promise<{ url: string }> {
  let email: string | undefined;
  if (ctx.principal.type === 'user') {
    const rows = await ctx.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, ctx.principal.id));
    email = rows[0]?.email;
  }

  const result = await billingGateway().createCheckout({
    workspaceId: ctx.workspaceId,
    customerEmail: email,
  });

  await ctx.db
    .update(subscriptions)
    .set({ stripeCustomerId: result.customerId, updatedAt: new Date() })
    .where(eq(subscriptions.workspaceId, ctx.workspaceId));

  return { url: result.url };
}

/**
 * Apply a normalized subscription event to the store. Called by the webhook route,
 * which has no tenant context — the event carries its own workspaceId (put there at
 * checkout), so we open a scoped transaction for it (satisfies RLS in production).
 */
export async function applySubscriptionEvent(db: Database, event: SubscriptionEvent): Promise<void> {
  await withWorkspace(db, event.workspaceId, async (tx) => {
    await tx
      .update(subscriptions)
      .set({
        plan: event.plan,
        status: event.status,
        stripeCustomerId: event.stripeCustomerId,
        stripeSubscriptionId: event.stripeSubscriptionId,
        currentPeriodEnd: event.currentPeriodEnd ?? null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.workspaceId, event.workspaceId));
  });
}
