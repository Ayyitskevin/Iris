import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, type TestApp } from './helpers';

/**
 * Liveness vs readiness (audit #14). /health must stay a cheap process-up check; /ready must
 * actually touch the DB so an orchestrator drains a pod whose database is unreachable instead
 * of a 200 /health masking the outage.
 */
describe('health and readiness probes', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('GET /health is a cheap liveness check (no auth, no DB)', async () => {
    const { status, json } = await call(t.app, 'GET', '/health');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('GET /ready returns 200 when the database is reachable', async () => {
    const { status, json } = await call(t.app, 'GET', '/ready');
    expect(status).toBe(200);
    expect(json.ready).toBe(true);
  });

  it('GET /ready returns 503 when the database is unreachable', async () => {
    const down = await makeApp();
    await down.client.close(); // sever the DB connection so `select 1` fails
    const { status, json } = await call(down.app, 'GET', '/ready');
    expect(status).toBe(503);
    expect(json.ready).toBe(false);
    await down.app.close().catch(() => undefined);
  });
});
