import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signUp, call, type TestApp } from './helpers';

describe('full Markdown export (pillar #1)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('exports the workspace as a zip of Markdown files', async () => {
    const u = await signUp(t.app);
    await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Exported note', bodyMd: '# Hello\n\nbody', folder: 'ideas' },
    });

    const res = (await t.app.inject({
      method: 'GET',
      url: '/v1/export',
      headers: { authorization: `Bearer ${u.token}` },
    })) as { statusCode: number; headers: Record<string, string>; rawPayload: Buffer };
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');

    // Zip magic bytes: 'P' 'K'.
    const buf = res.rawPayload;
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf.length).toBeGreaterThan(100);
  });

  it('requires authentication', async () => {
    const res = (await t.app.inject({ method: 'GET', url: '/v1/export' })) as {
      statusCode: number;
    };
    expect(res.statusCode).toBe(401);
  });
});
