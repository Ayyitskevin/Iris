import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_RATE_LIMIT_MAX, SEARCH_QUERY_MAX_LENGTH } from '@iris/shared';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * Per-IP rate limiting (audit #5). Rate limiting is off by default under NODE_ENV==='test'
 * (app.inject sends every request from 127.0.0.1, so a shared bucket would flake unrelated
 * files); this file opts in explicitly and asserts the deterministic 429.
 */
describe('rate limiting', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ rateLimit: true });
  });
  afterAll(() => t.close());

  it('throttles sign-in past the auth ceiling with the enveloped 429', async () => {
    let lastStatus = 0;
    let lastJson: any;
    // The bucket is shared across routes' per-IP key; exhaust the auth ceiling.
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX + 1; i += 1) {
      const res = await call(t.app, 'POST', '/v1/auth/sign-in', {
        body: { email: 'nobody@example.com', password: 'wrong-password' },
      });
      lastStatus = res.status;
      lastJson = res.json;
    }
    expect(lastStatus).toBe(429);
    // The plugin's response is shaped into the app's uniform error envelope.
    expect(lastJson.error.code).toBe('rate_limited');
    expect(typeof lastJson.error.message).toBe('string');
    const retryAfter = await call(t.app, 'POST', '/v1/auth/sign-in', {
      body: { email: 'nobody@example.com', password: 'wrong-password' },
    });
    expect(retryAfter.status).toBe(429);
  });

  it('rejects an oversized search query before touching the database', async () => {
    const user = await signUp(t.app);
    const res = await call(
      t.app,
      'GET',
      `/v1/notes/search?q=${'a'.repeat(SEARCH_QUERY_MAX_LENGTH + 1)}`,
      { token: user.token },
    );
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('search_query_too_long');
  });

  it('leaves normally-paced authenticated traffic unthrottled', async () => {
    const user = await signUp(t.app);
    const res = await call(t.app, 'GET', '/v1/notes', { token: user.token });
    expect(res.status).toBe(200);
  });
});
