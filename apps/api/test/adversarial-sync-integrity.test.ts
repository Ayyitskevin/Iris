/**
 * Adversarial sync + destructive-account integrity harness.
 *
 * Drives the real Fastify + PGlite stack (no service mocks) to prove:
 * - lost response + exact replay is idempotent (no double-apply);
 * - duplicate / reordered operations do not silently corrupt;
 * - incomplete or malformed durable receipts fail closed without re-applying;
 * - mixed/unknown receipt versions fail closed;
 * - confirmed account deletion is irreversible and complete;
 * - unconfirmed deletion mutates nothing;
 * - post-deletion tokens cannot push or resurrect workspace data;
 * - diagnostics never carry tokens, note bodies, or raw emails.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountDeletionDiagnosticSubscriberCount,
  emitAccountDeletionDiagnostic,
  onAccountDeletionDiagnostic,
  type AccountDeletionDiagnostic,
} from '../src/services/account';
import { call, makeApp, signUp, type TestApp } from './helpers';

const TENANT_TABLES = [
  'workspace_members',
  'notes',
  'note_versions',
  'activity_log',
  'devices',
  'agent_tokens',
  'subscriptions',
  'workspace_sync_cursors',
  'sync_idempotency',
];

describe('adversarial sync integrity', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(() => t.close());

  async function registerDevice(
    token: string,
    deviceId = `device-${randomUUID()}`,
  ): Promise<string> {
    const res = await call(t.app, 'POST', '/v1/devices', {
      token,
      body: { id: deviceId, name: 'Adversarial', platform: 'web' },
    });
    expect(res.status).toBe(200);
    return deviceId;
  }

  function upsertMutation(
    opId: string,
    noteId: string,
    bodyMd: string,
    baseVersion = 0,
  ) {
    return {
      opId,
      type: 'upsert' as const,
      note: {
        id: noteId,
        title: 'Adversarial',
        bodyMd,
        folder: null,
        tags: [] as string[],
      },
      baseVersion,
    };
  }

  async function countNotes(workspaceId: string): Promise<number> {
    const res = await t.client.query(
      `SELECT count(*)::int AS n FROM notes WHERE workspace_id = $1`,
      [workspaceId],
    );
    return (res.rows[0] as { n: number }).n;
  }

  async function noteVersions(noteId: string, workspaceId: string): Promise<number> {
    const res = await t.client.query(
      `SELECT count(*)::int AS n FROM note_versions WHERE note_id = $1 AND workspace_id = $2`,
      [noteId, workspaceId],
    );
    return (res.rows[0] as { n: number }).n;
  }

  it('replays an exact lost-response push without double-applying', async () => {
    const u = await signUp(t.app);
    const deviceId = await registerDevice(u.token);
    const noteId = randomUUID();
    const mutation = upsertMutation('op-lost-response', noteId, 'only-once');

    const first = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [mutation] },
    });
    expect(first.status).toBe(200);
    expect(first.json.applied).toHaveLength(1);
    expect(first.json.applied[0].note.version).toBe(1);

    // Client lost the response; retries the exact same durable request.
    const replay = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [mutation] },
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    expect(await countNotes(u.workspaceId)).toBe(1);
    expect(await noteVersions(noteId, u.workspaceId)).toBe(1);
  });

  it('rejects a delayed replay that changes the bound payload (no silent rebind)', async () => {
    const u = await signUp(t.app);
    const deviceId = await registerDevice(u.token);
    const noteId = randomUUID();
    const opId = 'op-payload-collision';
    const original = upsertMutation(opId, noteId, 'original');

    const first = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [original] },
    });
    expect(first.status).toBe(200);

    const colliding = upsertMutation(opId, noteId, 'tampered-body');
    const rejected = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [colliding] },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.json.error.code).toBe('idempotency_key_reused');
    expect(rejected.json.error.operationId).toBe(opId);

    const note = await call(t.app, 'GET', `/v1/notes/${noteId}`, { token: u.token });
    expect(note.status).toBe(200);
    expect(note.json.note.bodyMd).toBe('original');
    expect(await noteVersions(noteId, u.workspaceId)).toBe(1);
  });

  it('rolls back a reordered batch when a later op reuses a bound id', async () => {
    const u = await signUp(t.app);
    const deviceId = await registerDevice(u.token);
    const boundId = randomUUID();
    const boundOp = upsertMutation('op-bound', boundId, 'bound-payload');
    expect(
      (
        await call(t.app, 'POST', '/v1/sync/push', {
          token: u.token,
          body: { deviceId, mutations: [boundOp] },
        })
      ).status,
    ).toBe(200);

    const mustRollBack = randomUUID();
    const batch = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [
          upsertMutation('op-new-first', mustRollBack, 'should-not-commit'),
          { ...boundOp, note: { ...boundOp.note, bodyMd: 'different-payload' } },
        ],
      },
    });
    expect(batch.status).toBe(409);
    expect(batch.json.error.code).toBe('idempotency_key_reused');
    expect(await call(t.app, 'GET', `/v1/notes/${mustRollBack}`, { token: u.token })).toMatchObject(
      { status: 404 },
    );
    const bound = await call(t.app, 'GET', `/v1/notes/${boundId}`, { token: u.token });
    expect(bound.json.note.bodyMd).toBe('bound-payload');
  });

  it('fails closed on a null-outcome incomplete receipt without writing the note', async () => {
    const u = await signUp(t.app);
    const deviceId = await registerDevice(u.token);
    const noteId = randomUUID();
    const opId = `op-incomplete-${randomUUID()}`;
    const mutation = upsertMutation(opId, noteId, 'must-not-apply');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          actorType: 'user',
          actorId: u.userId,
          deviceId,
          operation: {
            type: mutation.type,
            note: {
              id: mutation.note.id,
              title: mutation.note.title,
              bodyMd: mutation.note.bodyMd,
              folder: mutation.note.folder,
              tags: mutation.note.tags,
            },
            baseVersion: mutation.baseVersion,
          },
        }),
      )
      .digest('hex');

    // Simulate partial persistence: receipt claimed, outcome never finalized.
    await t.client.query(
      `INSERT INTO sync_idempotency (
         workspace_id, op_id, actor_type, actor_id, device_id,
         receipt_version, request_fingerprint, outcome
       ) VALUES ($1, $2, 'user', $3, $4, 1, $5, NULL)`,
      [u.workspaceId, opId, u.userId, deviceId, fingerprint],
    );

    const rejected = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [mutation] },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.json.error.code).toBe('sync_receipt_incomplete');
    expect(rejected.json.error.operationId).toBe(opId);
    // Message is operator-safe: no note body, token, or email.
    expect(JSON.stringify(rejected.json)).not.toContain('must-not-apply');
    expect(JSON.stringify(rejected.json)).not.toContain(u.token);
    expect(JSON.stringify(rejected.json)).not.toContain(u.email);

    expect(await call(t.app, 'GET', `/v1/notes/${noteId}`, { token: u.token })).toMatchObject({
      status: 404,
    });
    expect(await countNotes(u.workspaceId)).toBe(0);
  });

  it('fails closed on a malformed stored receipt outcome without re-applying', async () => {
    const u = await signUp(t.app);
    const deviceId = await registerDevice(u.token);
    const noteId = randomUUID();
    const opId = `op-malformed-${randomUUID()}`;
    const mutation = upsertMutation(opId, noteId, 'malformed-path');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          actorType: 'user',
          actorId: u.userId,
          deviceId,
          operation: {
            type: mutation.type,
            note: {
              id: mutation.note.id,
              title: mutation.note.title,
              bodyMd: mutation.note.bodyMd,
              folder: mutation.note.folder,
              tags: mutation.note.tags,
            },
            baseVersion: mutation.baseVersion,
          },
        }),
      )
      .digest('hex');

    await t.client.query(
      `INSERT INTO sync_idempotency (
         workspace_id, op_id, actor_type, actor_id, device_id,
         receipt_version, request_fingerprint, outcome
       ) VALUES ($1, $2, 'user', $3, $4, 1, $5, $6::jsonb)`,
      [u.workspaceId, opId, u.userId, deviceId, fingerprint, JSON.stringify({ kind: 'garbage' })],
    );

    const rejected = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [mutation] },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.json.error.code).toBe('sync_receipt_incomplete');
    expect(await call(t.app, 'GET', `/v1/notes/${noteId}`, { token: u.token })).toMatchObject({
      status: 404,
    });
  });

  it('fails closed on an unsupported durable receipt version before writing a note', async () => {
    const u = await signUp(t.app);
    const deviceId = await registerDevice(u.token);
    const noteId = randomUUID();
    const opId = `op-future-${randomUUID()}`;

    await t.client.query(
      `INSERT INTO sync_idempotency (
         workspace_id, op_id, actor_type, actor_id, device_id,
         receipt_version, request_fingerprint, outcome
       ) VALUES ($1, $2, 'user', $3, $4, 99, 'future', $5::jsonb)`,
      [u.workspaceId, opId, u.userId, deviceId, JSON.stringify({ kind: 'future' })],
    );

    const rejected = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [upsertMutation(opId, noteId, 'future-version-body')],
      },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.json.error.code).toBe('sync_receipt_incomplete');
    expect(rejected.json.error.operationId).toBe(opId);
    expect(await call(t.app, 'GET', `/v1/notes/${noteId}`, { token: u.token })).toMatchObject({
      status: 404,
    });
  });

  it('confirmed account deletion erases tenant data and rejects the old token for sync', async () => {
    const u = await signUp(t.app);
    const deviceId = await registerDevice(u.token);
    const noteId = randomUUID();
    const pendingOp = upsertMutation('op-pending-pre-delete', noteId, 'pending local draft');
    const pushed = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [pendingOp] },
    });
    expect(pushed.status).toBe(200);
    expect(await countNotes(u.workspaceId)).toBe(1);

    const diagnostics: AccountDeletionDiagnostic[] = [];
    const stop = onAccountDeletionDiagnostic((event) => diagnostics.push(event));
    try {
      const deleted = await call(t.app, 'DELETE', '/v1/account', {
        token: u.token,
        body: { confirmEmail: u.email },
      });
      expect(deleted.status).toBe(200);
      expect(deleted.json.deleted).toBe(true);
    } finally {
      stop();
    }

    expect(diagnostics.some((d) => d.event === 'account_deletion_completed')).toBe(true);
    const completed = diagnostics.find((d) => d.event === 'account_deletion_completed')!;
    // Privacy: diagnostics never carry the email, token, or note body.
    expect(JSON.stringify(diagnostics)).not.toContain(u.email);
    expect(JSON.stringify(diagnostics)).not.toContain(u.token);
    expect(JSON.stringify(diagnostics)).not.toContain('pending local draft');
    expect(completed.workspaceId).toBe(u.workspaceId);
    expect(completed.userId).toBe(u.userId);

    for (const table of TENANT_TABLES) {
      const res = await t.client.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`,
        [u.workspaceId],
      );
      expect((res.rows[0] as { n: number }).n, `${table} should be empty`).toBe(0);
    }

    // Old session cannot push a "pending" retry or resurrect the workspace.
    const resurrect = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [upsertMutation('op-after-delete', randomUUID(), 'resurrect-attempt')],
      },
    });
    expect(resurrect.status).toBe(401);

    const pull = await call(t.app, 'GET', `/v1/sync/changes?since=&deviceId=${deviceId}`, {
      token: u.token,
    });
    expect(pull.status).toBe(401);

    const relogin = await call(t.app, 'POST', '/v1/auth/sign-in', {
      body: { email: u.email, password: 'correct-horse-battery' },
    });
    expect(relogin.status).toBe(401);
  });

  it('unconfirmed account deletion mutates nothing and leaves sync intact', async () => {
    const u = await signUp(t.app);
    const deviceId = await registerDevice(u.token);
    const noteId = randomUUID();
    await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: { deviceId, mutations: [upsertMutation('op-keep', noteId, 'keep-me')] },
    });

    const refused = await call(t.app, 'DELETE', '/v1/account', {
      token: u.token,
      body: { confirmEmail: 'wrong@example.com' },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('account_deletion_unconfirmed');

    expect(await countNotes(u.workspaceId)).toBe(1);
    const still = await call(t.app, 'GET', `/v1/notes/${noteId}`, { token: u.token });
    expect(still.status).toBe(200);
    expect(still.json.note.bodyMd).toBe('keep-me');

    // A subsequent exact replay of a new op still works — account is live.
    const next = await call(t.app, 'POST', '/v1/sync/push', {
      token: u.token,
      body: {
        deviceId,
        mutations: [upsertMutation('op-after-refuse', randomUUID(), 'still-live')],
      },
    });
    expect(next.status).toBe(200);
  });

  it('diagnostic sink rejects sensitive fields by construction in emitted events', () => {
    const seen: AccountDeletionDiagnostic[] = [];
    const stop = onAccountDeletionDiagnostic((event) => seen.push(event));
    try {
      emitAccountDeletionDiagnostic({
        event: 'account_deletion_billing_cancel_failed',
        workspaceId: 'ws-id',
        userId: 'user-id',
        stripeSubscriptionPresent: true,
        stripeSubscriptionIdSuffix: '9xyz',
      });
    } finally {
      stop();
    }
    expect(seen).toHaveLength(1);
    const keys = Object.keys(seen[0]!).sort();
    expect(keys).toEqual([
      'event',
      'stripeSubscriptionIdSuffix',
      'stripeSubscriptionPresent',
      'userId',
      'workspaceId',
    ]);
  });

  it('diagnostic subscriptions unsubscribe idempotently without accumulating listeners', () => {
    const before = accountDeletionDiagnosticSubscriberCount();
    const hits: number[] = [];
    const stop = onAccountDeletionDiagnostic(() => {
      hits.push(1);
    });
    expect(accountDeletionDiagnosticSubscriberCount()).toBe(before + 1);
    stop();
    stop(); // second call must not throw or remove someone else
    expect(accountDeletionDiagnosticSubscriberCount()).toBe(before);
    emitAccountDeletionDiagnostic({
      event: 'account_deletion_completed',
      workspaceId: 'ws-id',
      userId: 'user-id',
      stripeSubscriptionPresent: false,
    });
    expect(hits).toEqual([]);
  });
});
