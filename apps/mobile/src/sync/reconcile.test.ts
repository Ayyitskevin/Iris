import { describe, expect, it } from 'vitest';
import type { Note, SyncMutation, SyncPushResponse } from '@iris/shared';
import { drainChangePages, reconcilePush } from './reconcile';

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
});
