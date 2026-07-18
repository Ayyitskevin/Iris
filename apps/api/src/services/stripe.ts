/**
 * Billing gateway abstraction (ADR-007). The real gateway talks to Stripe; the fake
 * gateway is used whenever STRIPE_SECRET_KEY is unset, so the *gate logic* runs and is
 * testable with no live keys. Both produce the same normalized SubscriptionEvent, so
 * the webhook handler and subscription state machine don't know which is in play.
 */
import Stripe from 'stripe';
import type { Plan, SubscriptionStatus } from '@iris/shared';
import { env } from '../env';

export interface CheckoutParams {
  workspaceId: string;
  customerEmail?: string;
}

export interface CheckoutResult {
  url: string;
  customerId: string;
}

/** Provider-agnostic view of a subscription change. */
export interface SubscriptionEvent {
  workspaceId: string;
  plan: Plan;
  status: SubscriptionStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodEnd?: Date | null;
}

export interface BillingGateway {
  readonly mode: 'live' | 'fake';
  createCheckout(params: CheckoutParams): Promise<CheckoutResult>;
  /** Parse a raw webhook body into a normalized event, or null to ignore it. */
  handleWebhook(rawBody: string, signature: string | undefined): Promise<SubscriptionEvent | null>;
  /** Cancel a subscription so a deleted account is not billed again. */
  cancelSubscription(subscriptionId: string): Promise<void>;
}

function mapStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'none';
  }
}

const planForStatus = (status: SubscriptionStatus): Plan =>
  status === 'active' || status === 'trialing' ? 'sync' : 'free';

export class LiveStripeGateway implements BillingGateway {
  readonly mode = 'live' as const;
  private stripe: Stripe;

  constructor(
    secretKey: string,
    // Defaults to the configured secret so production wiring is unchanged; tests can
    // inject one because the vitest env never sets STRIPE_WEBHOOK_SECRET.
    private readonly webhookSecret: string | undefined = env.stripe.webhookSecret,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    const customer = await this.stripe.customers.create({
      email: params.customerEmail,
      metadata: { workspaceId: params.workspaceId },
    });
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: env.stripe.priceId, quantity: 1 }],
      success_url: env.stripe.successUrl,
      cancel_url: env.stripe.cancelUrl,
      // Carry the tenant on the subscription so webhooks can route without a lookup.
      subscription_data: { metadata: { workspaceId: params.workspaceId } },
      metadata: { workspaceId: params.workspaceId },
    });
    return { url: session.url ?? env.stripe.cancelUrl, customerId: customer.id };
  }

  async handleWebhook(
    rawBody: string,
    signature: string | undefined,
  ): Promise<SubscriptionEvent | null> {
    if (!this.webhookSecret || !signature) return null;
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    if (!event.type.startsWith('customer.subscription.')) return null;
    const sub = event.data.object as Stripe.Subscription;
    const workspaceId = sub.metadata?.workspaceId;
    if (!workspaceId) return null;
    const status =
      event.type === 'customer.subscription.deleted' ? 'canceled' : mapStatus(sub.status);
    // Stripe 22.x (basil) moved current_period_end onto the subscription items; fall back to
    // the legacy top-level field for older event shapes. Reading only the top level dropped
    // every paying customer's renewal date to null (audit #9).
    const periodEnd =
      (sub.items?.data?.[0] as { current_period_end?: number } | undefined)?.current_period_end ??
      (sub as unknown as { current_period_end?: number }).current_period_end;
    return {
      workspaceId,
      status,
      plan: planForStatus(status),
      stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
      stripeSubscriptionId: sub.id,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    };
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.cancel(subscriptionId);
  }
}

/**
 * Fake gateway. Checkout returns a stub URL; the webhook accepts a plain-JSON
 * SubscriptionEvent so tests (and manual dev) can drive subscription state directly.
 */
class FakeStripeGateway implements BillingGateway {
  readonly mode = 'fake' as const;

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    const customerId = `cus_fake_${params.workspaceId.slice(0, 8)}`;
    const url = `${env.apiBaseUrl}/v1/billing/fake-checkout?workspaceId=${params.workspaceId}`;
    return { url, customerId };
  }

  async handleWebhook(rawBody: string): Promise<SubscriptionEvent | null> {
    if (!rawBody) return null;
    const body = JSON.parse(rawBody) as Partial<SubscriptionEvent> & { status?: string };
    if (!body.workspaceId || !body.status) return null;
    const status = mapStatus(body.status);
    return {
      workspaceId: body.workspaceId,
      status,
      plan: planForStatus(status),
      stripeCustomerId: body.stripeCustomerId,
      stripeSubscriptionId: body.stripeSubscriptionId,
      currentPeriodEnd: body.currentPeriodEnd ? new Date(body.currentPeriodEnd) : null,
    };
  }

  async cancelSubscription(): Promise<void> {
    // No external provider to call; local subscription state is erased with the workspace.
  }
}

let gateway: BillingGateway | null = null;

export function billingGateway(): BillingGateway {
  if (!gateway) {
    gateway = env.stripe.secretKey
      ? new LiveStripeGateway(env.stripe.secretKey)
      : new FakeStripeGateway();
  }
  return gateway;
}
