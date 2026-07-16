import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * Phase 2: full-text search + tags. Both must be workspace-scoped (like everything
 * else), tags must be versioned with the note, and search must rank real matches.
 */
describe('tags', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('normalizes tags (trim/lowercase/dedupe) on create', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Tagged', bodyMd: 'x', tags: ['Work', ' work ', 'URGENT', 'urgent'] },
    });
    expect(created.status).toBe(201);
    expect(created.json.note.tags).toEqual(['work', 'urgent']);
  });

  it('updates tags and versions them (restore brings old tags back)', async () => {
    const u = await signUp(t.app);
    const created = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Note', bodyMd: 'body', tags: ['alpha'] },
    });
    const id = created.json.note.id;

    const updated = await call(t.app, 'PATCH', `/v1/notes/${id}`, {
      token: u.token,
      body: { tags: ['beta', 'gamma'], baseVersion: 1 },
    });
    expect(updated.json.note.tags).toEqual(['beta', 'gamma']);

    // The v1 snapshot still carries the original tags.
    const versions = await call(t.app, 'GET', `/v1/notes/${id}/versions`, { token: u.token });
    const v1 = versions.json.versions.find((v: any) => v.version === 1);
    expect(v1.tags).toEqual(['alpha']);

    // Restoring v1 brings ['alpha'] back as the new head.
    const restored = await call(t.app, 'POST', `/v1/notes/${id}/restore`, {
      token: u.token,
      body: { versionId: v1.id, baseVersion: 2 },
    });
    expect(restored.json.note.tags).toEqual(['alpha']);
  });

  it('lists tags with counts and filters notes by tag', async () => {
    const u = await signUp(t.app);
    await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'A', bodyMd: 'a', tags: ['work', 'idea'] },
    });
    await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'B', bodyMd: 'b', tags: ['work'] },
    });
    await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'C', bodyMd: 'c', tags: ['home'] },
    });

    const tags = await call(t.app, 'GET', '/v1/tags', { token: u.token });
    const map = Object.fromEntries(tags.json.tags.map((x: any) => [x.tag, x.count]));
    expect(map.work).toBe(2);
    expect(map.idea).toBe(1);
    expect(map.home).toBe(1);
    // Sorted by count desc — 'work' leads.
    expect(tags.json.tags[0].tag).toBe('work');

    const filtered = await call(t.app, 'GET', '/v1/notes?tag=work', { token: u.token });
    expect(filtered.json.notes).toHaveLength(2);
    expect(filtered.json.notes.every((n: any) => n.tags.includes('work'))).toBe(true);
  });

  it('keeps tags isolated per workspace', async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);
    await call(t.app, 'POST', '/v1/notes', {
      token: alice.token,
      body: { title: 'A', bodyMd: 'a', tags: ['alice-secret'] },
    });

    const bobTags = await call(t.app, 'GET', '/v1/tags', { token: bob.token });
    expect(bobTags.json.tags.find((x: any) => x.tag === 'alice-secret')).toBeUndefined();
  });
});

describe('full-text search', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('returns ranked matches and ignores non-matches', async () => {
    const u = await signUp(t.app);
    await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Rocket science', bodyMd: 'building a rocket engine' },
    });
    await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Garden', bodyMd: 'planting tomatoes' },
    });
    await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Fuel', bodyMd: 'oxidizer chemistry for rockets' },
    });

    const res = await call(t.app, 'GET', '/v1/notes/search?q=rocket', { token: u.token });
    expect(res.status).toBe(200);
    const titles = res.json.results.map((r: any) => r.note.title);
    expect(titles).toContain('Rocket science');
    expect(titles).toContain('Fuel'); // 'rockets' stems to 'rocket'
    expect(titles).not.toContain('Garden');
    // Ranks are present and descending.
    const ranks = res.json.results.map((r: any) => r.rank);
    expect(ranks[0]).toBeGreaterThanOrEqual(ranks[ranks.length - 1]);
  });

  it('excludes deleted notes and empty queries', async () => {
    const u = await signUp(t.app);
    const n = await call(t.app, 'POST', '/v1/notes', {
      token: u.token,
      body: { title: 'Findme', bodyMd: 'unique-token-xyzzy' },
    });
    let res = await call(t.app, 'GET', '/v1/notes/search?q=xyzzy', { token: u.token });
    expect(res.json.results).toHaveLength(1);

    await call(t.app, 'DELETE', `/v1/notes/${n.json.note.id}`, {
      token: u.token,
      body: { baseVersion: 1 },
    });
    res = await call(t.app, 'GET', '/v1/notes/search?q=xyzzy', { token: u.token });
    expect(res.json.results).toHaveLength(0);

    const empty = await call(t.app, 'GET', '/v1/notes/search?q=', { token: u.token });
    expect(empty.json.results).toHaveLength(0);
  });

  it('is workspace-scoped: A cannot find B notes', async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);
    await call(t.app, 'POST', '/v1/notes', {
      token: alice.token,
      body: { title: 'Confidential', bodyMd: 'alice-only-secretword' },
    });

    const bobSearch = await call(t.app, 'GET', '/v1/notes/search?q=secretword', {
      token: bob.token,
    });
    expect(bobSearch.json.results).toHaveLength(0);

    const aliceSearch = await call(t.app, 'GET', '/v1/notes/search?q=secretword', {
      token: alice.token,
    });
    expect(aliceSearch.json.results).toHaveLength(1);
  });
});
