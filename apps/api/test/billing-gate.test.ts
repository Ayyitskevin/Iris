import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * DoD: "Stripe subscription flow works end-to-end in test mode and gates multi-device
 * sync." With no live keys, the fake gateway drives subscription state; the gate math
 * (ADR-007) is the same either way: free = 1 device, paid = many.
 */
describe('billing gate on multi-device sync', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('blocks a second device on the free plan and unblocks after subscribing', async () => {
    const u = await signUp(t.app);

    // Free plan status.
    const status0 = await call(t.app, 'GET', '/v1/billing/status', { token: u.token });
    expect(status0.json.plan).toBe('free');
    expect(status0.json.deviceLimit).toBe(1);
    expect(status0.json.canSyncAnotherDevice).toBe(true);

    // First device: allowed.
    const d1 = `dev-${randomUUID()}`;
    const reg1 = await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: d1, name: 'Phone', platform: 'ios' },
    });
    expect(reg1.status).toBe(200);
    expect(reg1.json.activeDevices).toBe(1);

    // Second device on free plan: 402 Payment Required.
    const d2 = `dev-${randomUUID()}`;
    const reg2 = await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: d2, name: 'Laptop', platform: 'web' },
    });
    expect(reg2.status).toBe(402);
    expect(reg2.json.error.code).toBe('payment_required');

    // Syncing from the unregistered second device is likewise gated.
    const syncBlocked = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=&deviceId=${d2}`,
      { token: u.token },
    );
    expect(syncBlocked.status).toBe(402);

    // Start checkout (fake gateway returns a stub URL).
    const checkout = await call(t.app, 'POST', '/v1/billing/checkout', { token: u.token });
    expect(checkout.status).toBe(200);
    expect(checkout.json.url).toContain('workspaceId=');

    // Simulate Stripe activating the subscription via the webhook.
    const webhook = await call(t.app, 'POST', '/v1/billing/webhook', {
      body: {
        workspaceId: u.workspaceId,
        status: 'active',
        stripeSubscriptionId: 'sub_fake_123',
      },
    });
    expect(webhook.status).toBe(200);

    // Now on the sync plan: second device is allowed.
    const status1 = await call(t.app, 'GET', '/v1/billing/status', { token: u.token });
    expect(status1.json.plan).toBe('sync');
    expect(status1.json.status).toBe('active');
    expect(status1.json.deviceLimit).toBeGreaterThan(1);

    const reg2b = await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: d2, name: 'Laptop', platform: 'web' },
    });
    expect(reg2b.status).toBe(200);
    expect(reg2b.json.activeDevices).toBe(2);

    // And the previously-blocked device can now sync.
    const syncOk = await call(
      t.app,
      'GET',
      `/v1/sync/changes?since=&deviceId=${d2}`,
      { token: u.token },
    );
    expect(syncOk.status).toBe(200);
  });
});
