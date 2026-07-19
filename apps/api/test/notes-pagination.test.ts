import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTES_PAGE_MAX_LIMIT } from '@iris/shared';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * Audit #13: GET /v1/notes was unbounded — it returned every live note in one response.
 * It is now keyset-paginated on syncSeq (most-recently-changed first) with a default and a
 * hard-capped page size, and an opaque cursor. These tests prove a full walk covers every
 * note exactly once in order, the bounds hold, and bad input is rejected.
 */
describe('GET /v1/notes pagination', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  async function createNotes(token: string, count: number, tag?: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await call(t.app, 'POST', '/v1/notes', {
        token,
        body: { title: `note ${i}`, bodyMd: `body ${i}`, tags: tag ? [tag] : [] },
      });
      ids.push(res.json.note.id);
    }
    return ids;
  }

  /** Walk every page and return the ids in the order the server yielded them. */
  async function walk(
    token: string,
    limit: number,
    tag?: string,
  ): Promise<{ order: string[]; pages: number }> {
    const order: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (tag) params.set('tag', tag);
      if (cursor) params.set('cursor', cursor);
      const res = await call(t.app, 'GET', `/v1/notes?${params.toString()}`, { token });
      expect(res.status).toBe(200);
      order.push(...res.json.notes.map((n: { id: string }) => n.id));
      pages++;
      if (!res.json.nextCursor) break;
      cursor = res.json.nextCursor;
      if (pages > 100) throw new Error('runaway pagination — cursor never terminated');
    }
    return { order, pages };
  }

  it('walks every note exactly once, newest first, across pages', async () => {
    const u = await signUp(t.app);
    const created = await createNotes(u.token, 5);
    const newestFirst = [...created].reverse(); // syncSeq rises with each create

    const { order, pages } = await walk(u.token, 2);
    expect(pages).toBe(3); // 2 + 2 + 1
    expect(order).toEqual(newestFirst);
    expect(new Set(order).size).toBe(order.length); // no duplicates across pages
  });

  it('omits nextCursor and returns all notes when they fit in one page', async () => {
    const u = await signUp(t.app);
    await createNotes(u.token, 3);
    const res = await call(t.app, 'GET', '/v1/notes', { token: u.token });
    expect(res.status).toBe(200);
    expect(res.json.notes).toHaveLength(3);
    expect(res.json.nextCursor).toBeUndefined();
  });

  it('clamps an over-large limit to the ceiling instead of erroring', async () => {
    const u = await signUp(t.app);
    await createNotes(u.token, 4);
    const res = await call(t.app, 'GET', `/v1/notes?limit=${NOTES_PAGE_MAX_LIMIT + 5000}`, {
      token: u.token,
    });
    expect(res.status).toBe(200);
    expect(res.json.notes).toHaveLength(4);
    expect(res.json.nextCursor).toBeUndefined();
  });

  it('paginates within a tag filter', async () => {
    const u = await signUp(t.app);
    const tagged = await createNotes(u.token, 3, 'work');
    await createNotes(u.token, 2); // untagged noise that must not appear
    const { order } = await walk(u.token, 1, 'work');
    expect(order).toEqual([...tagged].reverse());
  });

  it('rejects a malformed cursor and a non-positive limit', async () => {
    const u = await signUp(t.app);
    await createNotes(u.token, 1);

    const badCursor = await call(t.app, 'GET', '/v1/notes?cursor=not-a-real-cursor', {
      token: u.token,
    });
    expect(badCursor.status).toBe(400);
    expect(badCursor.json.error.code).toBe('invalid_cursor');

    for (const limit of ['0', '-1', 'abc']) {
      const res = await call(t.app, 'GET', `/v1/notes?limit=${limit}`, { token: u.token });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('validation_error');
    }
  });

  it('keeps pagination workspace-scoped — one tenant never sees another via a cursor', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    await createNotes(a.token, 3);
    const bIds = await createNotes(b.token, 3);

    // Take A's next-page cursor, then hand it to B: B must still only ever see B's notes.
    const aFirst = await call(t.app, 'GET', '/v1/notes?limit=1', { token: a.token });
    const stolenCursor = aFirst.json.nextCursor as string;
    const bWithACursor = await call(
      t.app,
      'GET',
      `/v1/notes?cursor=${encodeURIComponent(stolenCursor)}`,
      { token: b.token },
    );
    expect(bWithACursor.status).toBe(200);
    for (const note of bWithACursor.json.notes) {
      expect(bIds).toContain(note.id);
    }
  });
});
