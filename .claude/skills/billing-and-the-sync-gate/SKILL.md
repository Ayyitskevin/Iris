---
name: billing-and-the-sync-gate
description: Open when touching Stripe/checkout/webhooks, the multi-device 402 gate, subscription state, or writing/fixing tests that drive billing without live keys.
---

## When to use

- A device registration returns **402 `payment_required`**, or sync rejects an
  unregistered device with **403 `forbidden`**, and you need to know which gate fired.
- You're wiring or debugging **Stripe** — checkout, the webhook, subscription state not updating after payment.
- You need to change the **device limit** per plan (`deviceLimit`) or the plan/status mapping.
- You're writing a test that must exercise subscription state **without live Stripe keys** (the fake gateway).
- A webhook fires but the workspace's plan never changes (usually a missing `workspaceId` in Stripe metadata).

## Mental model

Local use is always free. The paid feature is **reconciling more than one device**. The gate is pure counting: `activeDevices < deviceLimit(plan, status)`. Free = 1 device; the `sync` plan (~$5/mo) lifts it to 100.

Stripe is hidden behind a `BillingGateway` seam (`stripe.ts`) with two implementations selected **once** by whether `STRIPE_SECRET_KEY` is set: `LiveStripeGateway` (real Stripe) or `FakeStripeGateway` (stub URL + plain-JSON webhook). Both emit the same normalized `SubscriptionEvent`, so the state machine and the webhook route never know which is live — that's what makes the gate testable with no keys.

The webhook route has **no auth and no tenant context** (Stripe calls it). It routes to a workspace only because `workspaceId` was stamped into Stripe metadata at checkout and comes back on the event; `applySubscriptionEvent` re-opens a scoped transaction from that id. Subscription rows are the source of truth for the gate. A signed-in user explicitly registers a device through `POST /v1/devices`; `ensureDevice` locks the workspace row so count + insert are serialized. Sync accepts only a device already registered in the same workspace.

## Key files

- `apps/api/src/services/stripe.ts` — the gateway seam.
  - `BillingGateway` (iface): `mode`, `createCheckout`, `handleWebhook`.
  - `SubscriptionEvent` — provider-agnostic `{workspaceId, plan, status, stripeCustomerId?, stripeSubscriptionId?, currentPeriodEnd?}`.
  - `mapStatus` / `planForStatus` — Stripe status → our `SubscriptionStatus`; `active|trialing ⇒ plan 'sync'`, else `'free'`.
  - `LiveStripeGateway` / `FakeStripeGateway` — the two impls.
  - `billingGateway()` — **memoized singleton**, picks impl by `env.stripe.secretKey`.
- `apps/api/src/services/billing.ts` — gate math + subscription state.
  - `deviceLimit(plan, status)` — `FREE_DEVICE_LIMIT=1`, `SYNC_DEVICE_LIMIT=100`.
  - `getSubscription(ctx)` / `countDevices(ctx)` / `billingStatus(ctx)` — read side; all filter by `ctx.workspaceId`.
  - `createCheckout(ctx)` — fetches user email, calls gateway, saves `stripeCustomerId`.
  - `applySubscriptionEvent(db, event)` — the write path from the webhook; wraps in `withWorkspace(db, event.workspaceId, …)`.
- `apps/api/src/services/devices.ts` — where the gate is **enforced**.
  - `ensureDevice(ctx, id, meta?)` — the choke point: existing device passes free; new device runs the limit check and throws `paymentRequired(...)` at the limit.
  - `registerDevice` — POST `/v1/devices` handler; returns `{activeDevices}`.
  - `requireRegisteredDevice` — sync-only existence check. It updates `lastSeenAt` for
    a known workspace-composite id and returns 403 for an unknown one; it never
    auto-registers or consumes a plan slot.
- `apps/api/src/lib/errors.ts` — `paymentRequired(msg)` = `HttpError(402, 'payment_required', msg)`.
- `apps/api/src/app.ts` — routes: `POST /v1/devices`, `GET /v1/billing/status`,
  `POST /v1/billing/checkout`, and the **unauthenticated**
  `POST /v1/billing/webhook` (reads `req.rawBody` + `stripe-signature`).
- `apps/api/src/services/sync.ts` — `syncChanges`/`syncPush` both call
  `requireRegisteredDevice` first.
- `apps/api/test/billing-gate.test.ts` — the end-to-end reference test.

## Playbook

**Most common task: drive a subscription upgrade end-to-end with no Stripe keys** (this is exactly `billing-gate.test.ts`). With `STRIPE_SECRET_KEY` unset, `billingGateway()` returns the fake, so:

```ts
// 1. New workspace is free: limit 1.
const u = await signUp(t.app);
const s0 = await call(t.app, 'GET', '/v1/billing/status', { token: u.token });
// s0.json => { plan:'free', status:'none', deviceLimit:1, activeDevices:0, canSyncAnotherDevice:true }

// 2. First device registers fine.
await call(t.app, 'POST', '/v1/devices', {
  token: u.token,
  body: { id: d1, name: 'Phone', platform: 'ios' },
}); // 200, activeDevices:1

// 3. Second device on free plan is gated → 402 payment_required.
const reg2 = await call(t.app, 'POST', '/v1/devices', {
  token: u.token,
  body: { id: d2, name: 'Laptop', platform: 'web' },
});
// reg2.status === 402, reg2.json.error.code === 'payment_required'
// If d2 skips registration and calls sync, it gets 403 forbidden instead.

// 4. Upgrade via the FAKE webhook — a plain JSON SubscriptionEvent, no signature.
await call(t.app, 'POST', '/v1/billing/webhook', {
  body: { workspaceId: u.workspaceId, status: 'active', stripeSubscriptionId: 'sub_fake_123' },
}); // FakeStripeGateway.handleWebhook parses this body; needs workspaceId + status

// 5. Now plan==='sync', deviceLimit>1; the second device registers and syncs.
await call(t.app, 'POST', '/v1/devices', {
  token: u.token,
  body: { id: d2, name: 'Laptop', platform: 'web' },
}); // 200, activeDevices:2
```

Key point for step 4: the fake webhook body **is** a `SubscriptionEvent` (JSON), because `FakeStripeGateway.handleWebhook` just `JSON.parse`s `rawBody` and runs it through `mapStatus`. In production (`LiveStripeGateway`) the same route instead verifies a Stripe signature and reads `sub.metadata.workspaceId`. The webhook route code is identical; only the gateway differs.

**To change the paid device ceiling:** edit `SYNC_DEVICE_LIMIT` in `billing.ts`. To add a new plan tier, extend `deviceLimit(plan, status)` and `planForStatus` — both must agree on which statuses count as "paid active" (`active`/`trialing`).

## Invariants & gotchas

- **`workspaceId` MUST be in Stripe metadata.** `LiveStripeGateway.createCheckout` stamps it on the customer, the session, AND `subscription_data.metadata`. The webhook reads `sub.metadata.workspaceId` and returns `null` (silently ignored) if absent — the subscription would activate in Stripe but never update Iris. Don't drop any of those three metadata writes.
- **The billing gate lives only in `ensureDevice`.** The user-only `registerDevice`
  route is the only entry point that may allocate a device and therefore the only one
  that runs the plan-limit check. Sync endpoints call `requireRegisteredDevice`, which
  is an existence gate, not a registration path.
- **Existing devices never re-check the limit.** `ensureDevice` short-circuits for a known device id (just bumps `lastSeenAt`). This is deliberate: a customer who downgrades keeps already-synced devices working; the 402 only blocks _net-new_ devices. Don't "fix" this into a hard cap.
- **Device ids are workspace-composite.** The same client installation id may exist in
  two workspaces; every lookup and update pairs `devices.id` with `workspace_id`.
- **`billingGateway()` is a memoized singleton.** It reads `env.stripe.secretKey` on first call and caches the instance. Setting/unsetting `STRIPE_SECRET_KEY` after the process starts has no effect; tests rely on it being unset at boot to get the fake.
- **The webhook route is unauthenticated and uses the raw body.** `app.ts` keeps `req.rawBody` around specifically for Stripe signature verification (`constructEvent`). Don't route the webhook through `authGuard`/`tenant` — it has no principal; `applySubscriptionEvent` supplies its own workspace scope via `withWorkspace`.
- **`applySubscriptionEvent` opens its own scoped transaction.** It's called with the app-level `app.db` (not a `Ctx`) and must wrap writes in `withWorkspace(db, event.workspaceId, …)` to satisfy RLS in production. Don't call it with an ambient/unscoped db handle.
- **Live webhook only handles `customer.subscription.*` events; everything else returns `null`.** Deletions map to `'canceled'` regardless of `sub.status`. `current_period_end` is seconds → multiply by 1000 for the `Date`.
- **402 is `payment_required`.** REST note writes report `version_conflict` as HTTP
  409, while sync version mismatches are typed per-operation results in HTTP 200 and
  incompatible `opId` reuse is HTTP 409 `idempotency_key_reused`. Do not conflate any
  of these with the billing gate.
