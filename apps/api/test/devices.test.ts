import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * Device deregistration + slot reclamation (plan B4). Without this, a free-plan user
 * whose local replica is lost generates a fresh device id and is 402-locked forever
 * behind the stale slot. Deregistering the dead device must free the slot.
 */
describe('device deregistration + slot reclamation', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('frees the plan slot so a replacement device can register', async () => {
    const u = await signUp(t.app);
    const dead = `dev-${randomUUID()}`;
    const fresh = `dev-${randomUUID()}`;

    // First (free-plan) device registers.
    const reg1 = await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: dead, name: 'Old phone', platform: 'ios' },
    });
    expect(reg1.status).toBe(200);
    expect(reg1.json.activeDevices).toBe(1);

    // A replacement device (lost local state → new id) is blocked on the free plan.
    const blocked = await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: fresh, name: 'New phone', platform: 'ios' },
    });
    expect(blocked.status).toBe(402);

    // The user can see their devices...
    const list = await call(t.app, 'GET', '/v1/devices', { token: u.token });
    expect(list.json.devices).toHaveLength(1);
    expect(list.json.devices[0].id).toBe(dead);

    // ...and remove the dead one, freeing the slot.
    const del = await call(t.app, 'DELETE', `/v1/devices/${dead}`, { token: u.token });
    expect(del.status).toBe(200);
    expect(del.json.activeDevices).toBe(0);

    // Now the replacement registers successfully.
    const reg2 = await call(t.app, 'POST', '/v1/devices', {
      token: u.token,
      body: { id: fresh, name: 'New phone', platform: 'ios' },
    });
    expect(reg2.status).toBe(200);
    expect(reg2.json.activeDevices).toBe(1);
  });

  it('404s on unknown or cross-workspace devices', async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);
    const aliceDevice = `dev-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token: alice.token,
      body: { id: aliceDevice, name: 'A', platform: 'web' },
    });

    // Unknown id.
    const unknown = await call(t.app, 'DELETE', `/v1/devices/dev-${randomUUID()}`, {
      token: alice.token,
    });
    expect(unknown.status).toBe(404);

    // Bob cannot delete Alice's device, and it survives.
    const cross = await call(t.app, 'DELETE', `/v1/devices/${aliceDevice}`, { token: bob.token });
    expect(cross.status).toBe(404);
    const aliceList = await call(t.app, 'GET', '/v1/devices', { token: alice.token });
    expect(aliceList.json.devices).toHaveLength(1);
  });

  it('requires a user session (agents cannot manage devices)', async () => {
    const u = await signUp(t.app);
    const issued = await call(t.app, 'POST', '/v1/agents/tokens', {
      token: u.token,
      body: { agentName: 'Bot', scopes: ['notes:read', 'notes:write'] },
    });
    const agentToken = issued.json.token;

    const listed = await call(t.app, 'GET', '/v1/devices', { token: agentToken });
    expect(listed.status).toBe(403);
    const del = await call(t.app, 'DELETE', `/v1/devices/whatever`, { token: agentToken });
    expect(del.status).toBe(403);
  });
});
