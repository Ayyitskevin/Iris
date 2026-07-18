import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { LiveStripeGateway } from '../src/services/stripe';

/**
 * Audit #9: the PRODUCTION webhook path. billing-gate.test.ts only drives the FAKE
 * gateway (unsigned JSON), so LiveStripeGateway.handleWebhook — signature verification
 * and Stripe.Event → SubscriptionEvent normalization — was never exercised. Here we
 * construct the live gateway directly and stub this.stripe.webhooks.constructEvent to
 * return real-shaped Stripe.Subscription fixtures, with no live keys and no network.
 */

const WEBHOOK_SECRET = 'whsec_test_dummy';
const WORKSPACE_ID = 'ws_00000000-0000-0000-0000-000000000001';

/** A live gateway whose constructEvent is replaced. `new Stripe()` does no network I/O. */
function liveGateway(webhookSecret: string | undefined = WEBHOOK_SECRET): LiveStripeGateway {
  return new LiveStripeGateway('sk_test_dummy', webhookSecret);
}

/** Reach the private Stripe client to stub verification, as tests may. */
function stubConstructEvent(gw: LiveStripeGateway, impl: () => Stripe.Event): void {
  (gw as unknown as { stripe: Stripe }).stripe.webhooks.constructEvent = vi.fn(impl);
}

/**
 * A representative Stripe 22.x (basil) Subscription. Note current_period_end lives on
 * the subscription ITEM now, not the top level — the shape the audit flagged.
 */
function makeSubscription(overrides: {
  status: Stripe.Subscription.Status;
  workspaceId?: string;
  itemPeriodEnd?: number;
  topLevelPeriodEnd?: number;
}): Stripe.Subscription {
  const item: Record<string, unknown> = {
    id: 'si_test_1',
    object: 'subscription_item',
    current_period_start: 1_700_000_000,
  };
  // Only the basil (22.x) shape carries the period end on the item; leave it off otherwise so
  // the top-level fallback case is genuinely exercised.
  if (overrides.itemPeriodEnd !== undefined) item.current_period_end = overrides.itemPeriodEnd;
  return {
    id: 'sub_test_123',
    object: 'subscription',
    status: overrides.status,
    customer: 'cus_test_456',
    metadata: overrides.workspaceId === undefined ? {} : { workspaceId: overrides.workspaceId },
    items: { object: 'list', data: [item], has_more: false, url: '' },
    // Some historic fixtures still carry a top-level value; assert we honor it when present.
    ...(overrides.topLevelPeriodEnd !== undefined
      ? { current_period_end: overrides.topLevelPeriodEnd }
      : {}),
  } as unknown as Stripe.Subscription;
}

function subscriptionEvent(type: string, sub: Stripe.Subscription): Stripe.Event {
  return { id: 'evt_test', type, data: { object: sub } } as unknown as Stripe.Event;
}

describe('LiveStripeGateway.handleWebhook (production path)', () => {
  it('normalizes an active subscription to the sync plan', async () => {
    const gw = liveGateway();
    stubConstructEvent(gw, () =>
      subscriptionEvent(
        'customer.subscription.updated',
        makeSubscription({ status: 'active', workspaceId: WORKSPACE_ID }),
      ),
    );

    const event = await gw.handleWebhook('{"raw":"body"}', 't=1,v1=sig');

    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      workspaceId: WORKSPACE_ID,
      status: 'active',
      plan: 'sync',
      stripeCustomerId: 'cus_test_456',
      stripeSubscriptionId: 'sub_test_123',
    });
  });

  it('forces canceled + free plan on customer.subscription.deleted regardless of sub.status', async () => {
    const gw = liveGateway();
    // Stripe often still reports status "active" on the deleted event; we must not trust it.
    stubConstructEvent(gw, () =>
      subscriptionEvent(
        'customer.subscription.deleted',
        makeSubscription({ status: 'active', workspaceId: WORKSPACE_ID }),
      ),
    );

    const event = await gw.handleWebhook('{}', 'sig');

    expect(event).toMatchObject({ status: 'canceled', plan: 'free' });
  });

  it('maps past_due to the free plan (gate closes) while keeping the subscription id', async () => {
    const gw = liveGateway();
    stubConstructEvent(gw, () =>
      subscriptionEvent(
        'customer.subscription.updated',
        makeSubscription({ status: 'past_due', workspaceId: WORKSPACE_ID }),
      ),
    );

    const event = await gw.handleWebhook('{}', 'sig');

    expect(event).toMatchObject({
      status: 'past_due',
      plan: 'free',
      stripeSubscriptionId: 'sub_test_123',
    });
  });

  it('returns null (no verification attempted) when the signature header is missing', async () => {
    const gw = liveGateway();
    const spy = vi.fn(() =>
      subscriptionEvent('customer.subscription.updated', makeSubscription({ status: 'active' })),
    );
    stubConstructEvent(gw, spy);

    const event = await gw.handleWebhook('{}', undefined);

    expect(event).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null when no webhook secret is configured', async () => {
    const gw = liveGateway(undefined);
    const event = await gw.handleWebhook('{}', 'sig');
    expect(event).toBeNull();
  });

  it('propagates a rejected signature (constructEvent throws) instead of swallowing it', async () => {
    const gw = liveGateway();
    stubConstructEvent(gw, () => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    await expect(gw.handleWebhook('{}', 'bad-sig')).rejects.toThrow(/signature/i);
  });

  it('ignores events without a workspaceId in subscription metadata', async () => {
    const gw = liveGateway();
    stubConstructEvent(gw, () =>
      subscriptionEvent(
        'customer.subscription.updated',
        makeSubscription({ status: 'active' /* no workspaceId */ }),
      ),
    );

    const event = await gw.handleWebhook('{}', 'sig');
    expect(event).toBeNull();
  });

  it('ignores non-subscription event types', async () => {
    const gw = liveGateway();
    stubConstructEvent(
      gw,
      () => ({ id: 'evt', type: 'payment_intent.succeeded', data: { object: {} } }) as Stripe.Event,
    );

    const event = await gw.handleWebhook('{}', 'sig');
    expect(event).toBeNull();
  });

  it('maps a top-level current_period_end to a Date when present', async () => {
    const gw = liveGateway();
    stubConstructEvent(gw, () =>
      subscriptionEvent(
        'customer.subscription.updated',
        makeSubscription({
          status: 'active',
          workspaceId: WORKSPACE_ID,
          topLevelPeriodEnd: 1_702_592_000,
        }),
      ),
    );

    const event = await gw.handleWebhook('{}', 'sig');
    expect(event?.currentPeriodEnd).toEqual(new Date(1_702_592_000 * 1000));
  });

  it('AUDIT #9 / stripe 22.x: reads current_period_end from the subscription item', async () => {
    const gw = liveGateway();
    // A real basil-shaped subscription: current_period_end is ONLY on items.data[].
    stubConstructEvent(gw, () =>
      subscriptionEvent(
        'customer.subscription.updated',
        makeSubscription({
          status: 'active',
          workspaceId: WORKSPACE_ID,
          itemPeriodEnd: 1_702_592_000,
        }),
      ),
    );

    const event = await gw.handleWebhook('{}', 'sig');

    // The fix reads sub.items.data[0].current_period_end, so the paying customer's renewal
    // date is preserved instead of being dropped to null.
    expect(event?.currentPeriodEnd).toEqual(new Date(1_702_592_000 * 1000));
  });
});
