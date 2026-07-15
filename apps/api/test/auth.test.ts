import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

describe('auth + workspace provisioning', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('signs up a user and provisions their own workspace', async () => {
    const { status, json } = await call(t.app, 'POST', '/v1/auth/sign-up', {
      body: { email: 'alice@example.com', password: 'a-good-password', displayName: 'Alice' },
    });
    expect(status).toBe(201);
    expect(json.token).toBeTruthy();
    expect(json.user.email).toBe('alice@example.com');
    expect(json.workspace.id).toBeTruthy();
  });

  it('rejects duplicate emails', async () => {
    await call(t.app, 'POST', '/v1/auth/sign-up', {
      body: { email: 'dupe@example.com', password: 'a-good-password', displayName: 'Dupe' },
    });
    const { status, json } = await call(t.app, 'POST', '/v1/auth/sign-up', {
      body: { email: 'dupe@example.com', password: 'a-good-password', displayName: 'Dupe2' },
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe('email_taken');
  });

  it('signs in with correct credentials and rejects wrong ones', async () => {
    await call(t.app, 'POST', '/v1/auth/sign-up', {
      body: { email: 'bob@example.com', password: 'bobs-password', displayName: 'Bob' },
    });
    const ok = await call(t.app, 'POST', '/v1/auth/sign-in', {
      body: { email: 'bob@example.com', password: 'bobs-password' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.token).toBeTruthy();

    const bad = await call(t.app, 'POST', '/v1/auth/sign-in', {
      body: { email: 'bob@example.com', password: 'wrong' },
    });
    expect(bad.status).toBe(401);
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const { status } = await call(t.app, 'GET', '/v1/notes');
    expect(status).toBe(401);
  });

  it('returns the session identity from /me', async () => {
    const u = await signUp(t.app);
    const { status, json } = await call(t.app, 'GET', '/v1/auth/me', { token: u.token });
    expect(status).toBe(200);
    expect(json.workspace.id).toBe(u.workspaceId);
  });
});
