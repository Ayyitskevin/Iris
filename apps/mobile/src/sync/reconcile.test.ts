import { describe, expect, it } from 'vitest';
import type { Note, SyncMutation, SyncPushResponse } from '@iris/shared';
import { drainChangePages, reconcilePush, SYNC_CHANGE_PAGE_LIMIT } from './reconcile';

const detectedAt = '2026-07-15T12:00:00.000Z';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    title: 'Server title',
    bodyMd: 'server body',
    folder: null,
    tags: [],
    version: 1,
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function mutation(opId: string, bodyMd: string, baseVersion = 1, noteId = note().id): SyncMutation {
  return {
    opId,
    type: 'upsert',
    note: {
      id: noteId,
      title: 'Local title',
      bodyMd,
      folder: null,
      tags: ['local'],
    },
    baseVersion,
  };
}

describe('push reconciliation', () => {
  it('acknowledges only the sent op and preserves a newer in-flight edit', () => {
    const sent = mutation('op-sent', 'first edit');
    const newer = mutation('op-newer', 'newest edit');
    const server = note({ bodyMd: 'first edit', version: 2 });

    const result = reconcilePush(
      {
        notes: { [server.id]: note({ bodyMd: 'newest edit' }) },
        outbox: [newer],
        conflicts: {},
      },
      [sent],
      { applied: [{ opId: sent.opId, note: server }], conflicts: [] },
      detectedAt,
    );

    expect(result.outbox).toEqual([{ ...newer, baseVersion: 2 }]);
    expect(result.notes[server.id]).toMatchObject({ bodyMd: 'newest edit', version: 2 });
  });

  it('rebases a newer upsert after a staged resurrection becomes live', () => {
    const resurrection: SyncMutation = {
      ...mutation('op-resurrect', 'reviewed draft', 2),
      type: 'resurrect',
    };
    const newer = {
      ...mutation('op-newer', 'newest body', 2),
      note: {
        ...mutation('op-newer', 'newest body', 2).note,
        title: 'Newest title',
      },
    };
    const revived = note({
      title: resurrection.note.title,
      bodyMd: resurrection.note.bodyMd,
      version: 3,
      deletedAt: null,
    });

    const result = reconcilePush(
      {
        notes: {
          [revived.id]: note({
            title: newer.note.title,
            bodyMd: newer.note.bodyMd,
            version: 2,
            deletedAt: null,
          }),
        },
        outbox: [newer],
        conflicts: {},
      },
      [resurrection],
      { applied: [{ opId: resurrection.opId, note: revived }], conflicts: [] },
      detectedAt,
    );

    expect(result.outbox).toEqual([{ ...newer, baseVersion: 3 }]);
    expect(result.notes[revived.id]).toMatchObject({
      title: 'Newest title',
      bodyMd: 'newest body',
      version: 3,
      deletedAt: null,
    });
  });

  it('removes the exact acknowledged op when no newer edit exists', () => {
    const sent = mutation('op-sent', 'landed');
    const other = {
      ...mutation('op-other', 'other'),
      note: {
        ...mutation('x', '').note,
        id: '33333333-3333-4333-8333-333333333333',
      },
    };
    const server = note({ bodyMd: 'landed', version: 2 });

    const result = reconcilePush(
      { notes: { [server.id]: note() }, outbox: [sent, other], conflicts: {} },
      [sent],
      { applied: [{ opId: sent.opId, note: server }], conflicts: [] },
      detectedAt,
    );

    expect(result.outbox).toEqual([other]);
    expect(result.notes[server.id]).toEqual(server);
  });

  it('keeps both sides of a conflict and preserves the newest local draft', () => {
    const sent = mutation('op-sent', 'older local draft');
    const newer = mutation('op-newer', 'newest local draft');
    const server = note({ bodyMd: 'changed elsewhere', version: 4 });
    const response: SyncPushResponse = {
      applied: [],
      conflicts: [{ opId: sent.opId, reason: 'version_mismatch', serverNote: server }],
    };

    const result = reconcilePush(
      {
        notes: { [server.id]: note({ bodyMd: newer.note.bodyMd }) },
        outbox: [newer],
        conflicts: {},
      },
      [sent],
      response,
      detectedAt,
    );

    expect(result.outbox).toEqual([]);
    expect(result.notes[server.id]).toEqual(server);
    expect(result.conflicts[server.id]).toEqual({
      noteId: server.id,
      localMutation: newer,
      serverNote: server,
      detectedAt,
    });
  });

  it('retains an ordinary upsert draft when the authoritative server state is a tombstone', () => {
    const localDraft = mutation('op-old-client-upsert', 'retained old-client draft', 2);
    const tombstone = note({
      title: 'Deleted on another device',
      bodyMd: 'authoritative deleted body',
      version: 2,
      deletedAt: '2026-07-15T12:00:00.000Z',
    });

    const result = reconcilePush(
      {
        notes: {
          [tombstone.id]: note({
            title: localDraft.note.title,
            bodyMd: localDraft.note.bodyMd,
            version: 2,
          }),
        },
        outbox: [localDraft],
        conflicts: {},
      },
      [localDraft],
      {
        applied: [],
        conflicts: [{ opId: localDraft.opId, reason: 'version_mismatch', serverNote: tombstone }],
      },
      detectedAt,
    );

    expect(result.outbox).toEqual([]);
    expect(result.notes[tombstone.id]).toEqual(tombstone);
    expect(result.conflicts[tombstone.id]).toEqual({
      noteId: tombstone.id,
      localMutation: localDraft,
      serverNote: tombstone,
      detectedAt,
    });
  });

  it('retains multiple independent conflicts without dropping unrelated work', () => {
    const firstId = note().id;
    const secondId = '33333333-3333-4333-8333-333333333333';
    const thirdId = '44444444-4444-4444-8444-444444444444';
    const firstSent = mutation('op-first', 'first local', 1, firstId);
    const secondSent = mutation('op-second', 'second older local', 2, secondId);
    const secondNewer = mutation('op-second-newer', 'second newest local', 2, secondId);
    const unrelated = mutation('op-unrelated', 'still pending', 1, thirdId);
    const firstServer = note({ bodyMd: 'first server', version: 5 });
    const secondServer = note({ id: secondId, bodyMd: 'second server', version: 8 });

    const result = reconcilePush(
      {
        notes: {
          [firstId]: note({ bodyMd: firstSent.note.bodyMd }),
          [secondId]: note({ id: secondId, bodyMd: secondNewer.note.bodyMd }),
        },
        outbox: [firstSent, secondNewer, unrelated],
        conflicts: {},
      },
      [firstSent, secondSent],
      {
        applied: [],
        conflicts: [
          { opId: firstSent.opId, reason: 'version_mismatch', serverNote: firstServer },
          { opId: secondSent.opId, reason: 'version_mismatch', serverNote: secondServer },
        ],
      },
      detectedAt,
    );

    expect(result.outbox).toEqual([unrelated]);
    expect(result.conflicts[firstId]?.localMutation).toEqual(firstSent);
    expect(result.conflicts[secondId]?.localMutation).toEqual(secondNewer);
    expect(result.notes[firstId]).toEqual(firstServer);
    expect(result.notes[secondId]).toEqual(secondServer);
  });

  it('rejects an applied upsert that omits its authoritative note', () => {
    const sent = mutation('op-sent', 'draft');

    expect(() =>
      reconcilePush(
        { notes: { [sent.note.id]: note() }, outbox: [sent], conflicts: {} },
        [sent],
        { applied: [{ opId: sent.opId }], conflicts: [] },
        detectedAt,
      ),
    ).toThrow('omitted its authoritative note');
  });

  it('requires an authoritative live note for an applied resurrection', () => {
    const resurrection: SyncMutation = {
      ...mutation('op-resurrect', 'reviewed draft', 2),
      type: 'resurrect',
    };

    expect(() =>
      reconcilePush(
        { notes: {}, outbox: [resurrection], conflicts: {} },
        [resurrection],
        { applied: [{ opId: resurrection.opId }], conflicts: [] },
        detectedAt,
      ),
    ).toThrow('omitted its authoritative note');

    expect(() =>
      reconcilePush(
        { notes: {}, outbox: [resurrection], conflicts: {} },
        [resurrection],
        {
          applied: [
            {
              opId: resurrection.opId,
              note: note({ version: 3, deletedAt: '2026-07-15T12:01:00.000Z' }),
            },
          ],
          conflicts: [],
        },
        detectedAt,
      ),
    ).toThrow('returned a deleted note');

    const live = note({ bodyMd: 'reviewed draft', version: 3, deletedAt: null });
    const result = reconcilePush(
      { notes: {}, outbox: [resurrection], conflicts: {} },
      [resurrection],
      { applied: [{ opId: resurrection.opId, note: live }], conflicts: [] },
      detectedAt,
    );
    expect(result.notes[live.id]).toEqual(live);
    expect(result.outbox).toEqual([]);
  });

  it('rejects a same-workspace acknowledgement for another note', () => {
    const sent = mutation('op-sent', 'draft');
    const otherId = '33333333-3333-4333-8333-333333333333';

    expect(() =>
      reconcilePush(
        { notes: { [sent.note.id]: note() }, outbox: [sent], conflicts: {} },
        [sent],
        {
          applied: [{ opId: sent.opId, note: note({ id: otherId, version: 2 }) }],
          conflicts: [],
        },
        detectedAt,
      ),
    ).toThrow('did not match its operation');
  });

  it('rejects applied notes with semantics opposite to the sent mutation', () => {
    const upsert = mutation('op-upsert', 'draft');
    const deletion: SyncMutation = { ...mutation('op-delete', 'delete'), type: 'delete' };

    expect(() =>
      reconcilePush(
        { notes: {}, outbox: [upsert], conflicts: {} },
        [upsert],
        {
          applied: [
            {
              opId: upsert.opId,
              note: note({ version: 2, deletedAt: '2026-07-15T12:00:00.000Z' }),
            },
          ],
          conflicts: [],
        },
        detectedAt,
      ),
    ).toThrow('returned a deleted note');

    expect(() =>
      reconcilePush(
        { notes: {}, outbox: [deletion], conflicts: {} },
        [deletion],
        { applied: [{ opId: deletion.opId, note: note({ version: 2 }) }], conflicts: [] },
        detectedAt,
      ),
    ).toThrow('returned a live note');
  });

  it('rejects duplicate and missing operation results', () => {
    const first = mutation('op-first', 'first');
    const second = mutation('op-second', 'second', 1, '33333333-3333-4333-8333-333333333333');

    expect(() =>
      reconcilePush(
        { notes: {}, outbox: [first, second], conflicts: {} },
        [first, second],
        {
          applied: [{ opId: first.opId, note: note({ version: 2 }) }],
          conflicts: [
            {
              opId: first.opId,
              reason: 'version_mismatch',
              serverNote: note({ version: 3 }),
            },
          ],
        },
        detectedAt,
      ),
    ).toThrow('repeated an operation result');

    expect(() =>
      reconcilePush(
        { notes: {}, outbox: [first, second], conflicts: {} },
        [first, second],
        { applied: [{ opId: first.opId, note: note({ version: 2 }) }], conflicts: [] },
        detectedAt,
      ),
    ).toThrow('omitted an operation result');
  });
});

describe('pull pagination', () => {
  it('drains every page and advances the cursor in order', async () => {
    const seen: string[] = [];
    const applied: string[] = [];
    const finalCursor = await drainChangePages(
      'genesis',
      async (cursor) => {
        seen.push(cursor);
        return cursor === 'genesis'
          ? { changes: [note()], cursor: 'page-1', hasMore: true }
          : { changes: [note({ version: 2 })], cursor: 'page-2', hasMore: false };
      },
      (page) => {
        applied.push(page.cursor);
      },
    );

    expect(seen).toEqual(['genesis', 'page-1']);
    expect(applied).toEqual(['page-1', 'page-2']);
    expect(finalCursor).toBe('page-2');
  });

  it('fails loud if a full page does not advance the cursor', async () => {
    await expect(
      drainChangePages(
        'stuck',
        async () => ({ changes: [], cursor: 'stuck', hasMore: true }),
        () => undefined,
      ),
    ).rejects.toThrow('without advancing');
  });

  it('does not apply a nonempty final page whose cursor did not advance', async () => {
    const applied: string[] = [];
    await expect(
      drainChangePages(
        'stuck',
        async () => ({ changes: [note()], cursor: 'stuck', hasMore: false }),
        (page) => {
          applied.push(page.cursor);
        },
      ),
    ).rejects.toThrow('without advancing');
    expect(applied).toEqual([]);
  });

  it('detects a cursor cycle before applying the repeated page', async () => {
    const pages = new Map([
      ['genesis', { changes: [], cursor: 'page-a', hasMore: true }],
      ['page-a', { changes: [], cursor: 'page-b', hasMore: true }],
      ['page-b', { changes: [], cursor: 'page-a', hasMore: true }],
    ]);
    const applied: string[] = [];

    await expect(
      drainChangePages(
        'genesis',
        async (cursor) => pages.get(cursor)!,
        (page) => {
          applied.push(page.cursor);
        },
      ),
    ).rejects.toThrow('repeated an earlier cursor');
    expect(applied).toEqual(['page-a', 'page-b']);
  });

  it('fails after a high but finite number of unique pages', async () => {
    let fetched = 0;
    let applied = 0;

    await expect(
      drainChangePages(
        'genesis',
        async () => {
          fetched += 1;
          return { changes: [], cursor: `page-${fetched}`, hasMore: true };
        },
        () => {
          applied += 1;
        },
      ),
    ).rejects.toThrow('exceeded its page limit');
    expect(fetched).toBe(SYNC_CHANGE_PAGE_LIMIT);
    expect(applied).toBe(SYNC_CHANGE_PAGE_LIMIT);
  });
});
