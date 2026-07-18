import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeApp, signUp, type TestApp } from './helpers';

/**
 * Audit #15: sync_idempotency records one durable receipt per sync operation, forever. Left
 * unbounded it grows for the life of a workspace. syncPush now prunes receipts older than the
 * retention window on every non-empty batch, under the workspace sync lock it already holds.
 * These tests prove old receipts are collected, fresh ones and note data are untouched, and
 * the sweep never crosses a tenant boundary.
 */
describe('sync idempotency-key garbage collection', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  async function registerDevice(token: string): Promise<string> {
    const deviceId = `device-${randomUUID()}`;
    await call(t.app, 'POST', '/v1/devices', {
      token,
      body: { id: deviceId, name: 'GC test', platform: 'web' },
    });
    return deviceId;
  }

  function upsert(opId: string, noteId: string, bodyMd: string) {
    return {
      opId,
      type: 'upsert' as const,
      note: { id: noteId, title: 'Note', bodyMd, folder: null, tags: [] },
      baseVersion: 0,
    };
  }

  async function receiptOpIds(workspaceId: string): Promise<string[]> {
    const { rows } = await t.client.query(
      `SELECT op_id FROM sync_idempotency WHERE workspace_id = $1 ORDER BY op_id`,
      [workspaceId],
    );
    return (rows as Array<{ op_id: string }>).map((r) => r.op_id);
  }

  /** Backdate a receipt's created_at so the next push's GC treats it as expired. */
  async function ageReceipt(workspaceId: string, opId: string): Promise<void> {
    await t.client.query(
      `UPDATE sync_idempotency SET created_at = now() - interval '40 days'
       WHERE workspace_id = $1 AND op_id = $2`,
      [workspaceId, opId],
    );
  }

  it('prunes receipts past the retention window but keeps fresh ones and the note data', async () => {
    const u = await signUp(t.app);
    const deviceId = await registerDevice(u.token);
    const oldNote = randomUUID();
    const newNote = randomUUID();

    const first = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [upsert('gc-old', oldNote, 'old')] },
    });
    expect(first.status).toBe(200);
    expect(await receiptOpIds(u.workspaceId)).toEqual(['gc-old']);

    // Backdate the first receipt so the next push sees it as expired.
    await ageReceipt(u.workspaceId, 'gc-old');

    const second = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [upsert('gc-new', newNote, 'new')] },
    });
    expect(second.status).toBe(200);

    // The aged receipt is gone; the fresh receipt from this very batch survives.
    expect(await receiptOpIds(u.workspaceId)).toEqual(['gc-new']);

    // GC touches receipts only — both notes remain live and readable.
    expect((await call(t.app, 'GET', `/v1/notes/${oldNote}`, { token: u.token })).status).toBe(200);
    expect((await call(t.app, 'GET', `/v1/notes/${newNote}`, { token: u.token })).status).toBe(200);
  });

  it('never collects another workspace’s receipts', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const deviceA = await registerDevice(a.token);
    const deviceB = await registerDevice(b.token);

    // Both workspaces have an aged receipt.
    await call(t.app, 'POST', '/v1/sync/push', {
      token: a.token,
      body: { deviceId: deviceA, mutations: [upsert('a-old', randomUUID(), 'a')] },
    });
    await call(t.app, 'POST', '/v1/sync/push', {
      token: b.token,
      body: { deviceId: deviceB, mutations: [upsert('b-old', randomUUID(), 'b')] },
    });
    await ageReceipt(a.workspaceId, 'a-old');
    await ageReceipt(b.workspaceId, 'b-old');

    // A pushes again — its GC must not reach into workspace B.
    await call(t.app, 'POST', '/v1/sync/push', {
      token: a.token,
      body: { deviceId: deviceA, mutations: [upsert('a-new', randomUUID(), 'a2')] },
    });

    expect(await receiptOpIds(a.workspaceId)).toEqual(['a-new']);
    expect(await receiptOpIds(b.workspaceId)).toEqual(['b-old']);
  });
});
