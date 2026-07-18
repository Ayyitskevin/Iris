import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signUp, call, type TestApp } from './helpers';

/** Count of export temp files currently spooled on disk (audit #6 leak guard). */
function exportTempCount(): number {
  return readdirSync(tmpdir()).filter((f) => f.startsWith('iris-export-')).length;
}

/** ZIP end-of-central-directory signature — proves a complete, well-formed archive. */
const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

describe('full Markdown export (pillar #1)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  async function exportZip(
    token: string,
  ): Promise<{ statusCode: number; buf: Buffer; ct?: string }> {
    const res = (await t.app.inject({
      method: 'GET',
      url: '/v1/export',
      headers: { authorization: `Bearer ${token}` },
    })) as { statusCode: number; headers: Record<string, string>; rawPayload: Buffer };
    return { statusCode: res.statusCode, buf: res.rawPayload, ct: res.headers['content-type'] };
  }

  it('exports the workspace as a zip of Markdown files', async () => {
    const u = await signUp(t.app);
    await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Exported note', bodyMd: '# Hello\n\nbody', folder: 'ideas' },
    });

    const { statusCode, buf, ct } = await exportZip(u.token);
    expect(statusCode).toBe(200);
    expect(ct).toContain('application/zip');

    // Zip local-file magic ('P' 'K') plus a complete central directory.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.includes(EOCD)).toBe(true);
  });

  it('streams every note plus a manifest, and de-dupes colliding titles', async () => {
    const u = await signUp(t.app);
    // Two notes share a title, so the second must get a disambiguating suffix.
    for (const body of [
      { title: 'Duplicate', bodyMd: 'first body', folder: 'shared' },
      { title: 'Duplicate', bodyMd: 'second body', folder: 'shared' },
      { title: 'Solo', bodyMd: 'solo body' },
    ]) {
      await call(t.app, 'POST', '/v1/notes', { token: u.token, body });
    }

    const { statusCode, buf } = await exportZip(u.token);
    expect(statusCode).toBe(200);

    // Zip stores entry names uncompressed in the local headers, so the archive bytes
    // literally contain each file path — assert them without an unzip dependency.
    expect(buf.includes(Buffer.from('manifest.json'))).toBe(true);
    expect(buf.includes(Buffer.from('README.md'))).toBe(true);
    expect(buf.includes(Buffer.from('notes/shared/duplicate-'))).toBe(true);
    // The dedup suffix (…-2-) proves collision handling survived the streaming rewrite.
    expect(buf.includes(Buffer.from('duplicate-2-'))).toBe(true);
    expect(buf.includes(Buffer.from('notes/solo-'))).toBe(true);
  });

  it('leaves no export temp file behind once the response is sent', async () => {
    const u = await signUp(t.app);
    await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Temp cleanup', bodyMd: 'x' },
    });

    const { statusCode } = await exportZip(u.token);
    expect(statusCode).toBe(200);

    // Cleanup fires on the read stream's 'close', which may land a tick after inject resolves.
    for (let i = 0; i < 50 && exportTempCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(exportTempCount()).toBe(0);
  });

  it('requires authentication', async () => {
    const res = (await t.app.inject({ method: 'GET', url: '/v1/export' })) as {
      statusCode: number;
    };
    expect(res.statusCode).toBe(401);
  });
});
