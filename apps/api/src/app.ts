/**
 * The Iris API — one Fastify service, every route workspace-scoped (ADR-006). Built as
 * a factory so tests can spin it up against a fresh PGlite and the server entrypoint can
 * run it for real. Auth = user session JWT or agent token; both resolve to a Principal
 * bound to exactly one workspace.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import archiver from 'archiver';
import { eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  AUTH_RATE_LIMIT_MAX,
  CreateNoteRequest,
  DeleteAccountRequest,
  EXPORT_RATE_LIMIT_MAX,
  GLOBAL_RATE_LIMIT_MAX,
  IssueAgentTokenRequest,
  ListNotesQuery,
  RATE_LIMIT_WINDOW,
  RegisterDeviceRequest,
  RestoreVersionRequest,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_RATE_LIMIT_MAX,
  SignInRequest,
  SignUpRequest,
  RESTORE_PROTOCOL_VERSION,
  SYNC_HTTP_BODY_LIMIT_BYTES,
  SyncChangesRequest,
  SyncPushRequest,
  SyncV2ChangesRequest,
  SyncV2PushRequest,
  UNDO_PROTOCOL_VERSION,
  UpdateNoteRequest,
  type AuthResponse,
} from '@iris/shared';
import type { DbBundle } from './db/client';
import type { Principal } from './auth/provider';
import { getAuthProvider } from './auth';
import { signSession } from './auth/jwt';
import { resolvePrincipal } from './middleware/authenticate';
import { runTenant } from './tenant';
import { requireScope } from './context';
import { users, workspaces } from './db/schema';
import { serializeUser, serializeVersion, serializeWorkspace } from './serialize';
import { badRequest, forbidden, HttpError, unauthorized } from './lib/errors';
import * as notesService from './services/notes';
import * as searchService from './services/search';
import * as activityService from './services/activity';
import * as agentService from './services/agents';
import * as syncService from './services/sync';
import * as syncV2Service from './services/sync-v2';
import * as deviceService from './services/devices';
import * as billingService from './services/billing';
import * as accountService from './services/account';
import { exportFiles } from './services/export';
import { billingGateway } from './services/stripe';

declare module 'fastify' {
  interface FastifyInstance {
    db: DbBundle['db'];
    dbKind: string;
  }
  interface FastifyRequest {
    principal?: Principal;
    rawBody?: string;
  }
}

export interface BuildAppOptions {
  /**
   * Enable per-IP rate limiting. Defaults on outside NODE_ENV==='test': `app.inject` sends
   * every request from 127.0.0.1, so a shared bucket would flake unrelated test files; the
   * dedicated rate-limit test opts in explicitly.
   */
  rateLimit?: boolean;
}

export async function buildApp(
  bundle: DbBundle,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' },
    bodyLimit: SYNC_HTTP_BODY_LIMIT_BYTES,
    // Behind a reverse proxy request.ip is the proxy unless X-Forwarded-For is trusted;
    // without this a production deploy would rate-limit all users as one client.
    trustProxy: process.env.TRUST_PROXY === 'true',
  });

  app.decorate('db', bundle.db);
  app.decorate('dbKind', bundle.kind);

  // Keep the raw body around (Stripe webhook signature needs it) while still parsing JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      const error = new Error('Request body is not valid JSON') as Error & {
        statusCode: number;
        code: string;
      };
      error.statusCode = 400;
      error.code = 'invalid_json';
      done(error, undefined);
    }
  });

  // Awaited so their hooks (esp. rate-limit's onRoute + global onRequest) are installed
  // before the routes below are registered — otherwise per-route config is never applied.
  await app.register(cors, { origin: true });

  const rateLimitEnabled = options.rateLimit ?? process.env.NODE_ENV !== 'test';
  if (rateLimitEnabled) {
    // The plugin's 429 error flows through setErrorHandler below, which maps it into the
    // app's uniform `{ error: { code: 'rate_limited', message } }` envelope.
    await app.register(rateLimit, {
      global: true,
      max: GLOBAL_RATE_LIMIT_MAX,
      timeWindow: RATE_LIMIT_WINDOW,
    });
  }
  /** Per-route override; inert metadata when the plugin is not registered (tests). */
  const routeRateLimit = (max: number) => ({
    rateLimit: { max, timeWindow: RATE_LIMIT_WINDOW },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          conflict: err.conflict,
          operationId: err.operationId,
        },
      });
    }
    if (err instanceof ZodError) {
      const message = err.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return reply.status(400).send({ error: { code: 'validation_error', message } });
    }
    const requestError = err as Error & { statusCode?: number; code?: string };
    if (
      requestError.statusCode !== undefined &&
      requestError.statusCode >= 400 &&
      requestError.statusCode < 500
    ) {
      const status = requestError.statusCode;
      const code =
        status === 429
          ? 'rate_limited'
          : status === 413
            ? 'payload_too_large'
            : requestError.code === 'invalid_json'
              ? 'invalid_json'
              : 'invalid_request';
      const message =
        status === 413 ? 'Request body exceeds the Iris transport limit' : requestError.message;
      return reply.status(status).send({ error: { code, message } });
    }
    req.log.error(err);
    const message =
      process.env.NODE_ENV === 'production' ? 'Something went wrong' : (err as Error).message;
    return reply.status(500).send({ error: { code: 'internal_error', message } });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const authGuard = async (req: FastifyRequest) => {
    req.principal = await resolvePrincipal(app.db, req.headers.authorization);
  };
  const principalOf = (req: FastifyRequest): Principal => {
    if (!req.principal) throw unauthorized();
    return req.principal;
  };
  const requireUser = (p: Principal): void => {
    if (p.type !== 'user') throw forbidden('This endpoint requires a signed-in user');
  };
  const tenant = <T>(req: FastifyRequest, fn: Parameters<typeof runTenant<T>>[2]): Promise<T> =>
    runTenant(app.db, principalOf(req), fn);

  async function buildAuthResponse(
    authed: { userId: string; workspaceId: string },
    token: string,
  ): Promise<AuthResponse> {
    const [u] = await app.db.select().from(users).where(eq(users.id, authed.userId));
    const [w] = await app.db.select().from(workspaces).where(eq(workspaces.id, authed.workspaceId));
    return { token, user: serializeUser(u!), workspace: serializeWorkspace(w!) };
  }

  const guarded = { preHandler: authGuard };

  // ── Health / readiness ─────────────────────────────────────────────────────
  // Liveness: cheap, no dependencies — is the process up? (never touch the DB here.)
  app.get('/health', async () => ({ ok: true, db: app.dbKind }));

  // Readiness: is the pod able to serve real traffic? Ping the DB so an orchestrator drains
  // a pod whose database is unreachable (a 200 /health would otherwise keep routing to it).
  app.get('/ready', async (_req, reply) => {
    try {
      await app.db.execute(sql`select 1`);
      return { ready: true, db: app.dbKind };
    } catch (err) {
      app.log.error(err);
      return reply.status(503).send({ ready: false });
    }
  });

  // ── Auth ────────────────────────────────────────────────────────────────
  // Tightly throttled: each attempt runs an expensive scrypt hash, so an unthrottled
  // endpoint is both a brute-force and a CPU-DoS vector (audit #5).
  app.post(
    '/v1/auth/sign-up',
    { config: routeRateLimit(AUTH_RATE_LIMIT_MAX) },
    async (req, reply) => {
      const input = SignUpRequest.parse(req.body);
      const authed = await getAuthProvider().signUp(app.db, input);
      const token = await signSession({ sub: authed.userId, wid: authed.workspaceId });
      return reply.status(201).send(await buildAuthResponse(authed, token));
    },
  );

  app.post('/v1/auth/sign-in', { config: routeRateLimit(AUTH_RATE_LIMIT_MAX) }, async (req) => {
    const input = SignInRequest.parse(req.body);
    const authed = await getAuthProvider().signIn(app.db, input);
    const token = await signSession({ sub: authed.userId, wid: authed.workspaceId });
    return buildAuthResponse(authed, token);
  });

  app.get('/v1/auth/me', guarded, async (req) => {
    const p = principalOf(req);
    requireUser(p);
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return buildAuthResponse({ userId: p.id, workspaceId: p.workspaceId }, token);
  });

  // ── Notes ──────────────────────────────────────────────────────────────
  app.get('/v1/notes', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      return notesService.listNotes(ctx, ListNotesQuery.parse(req.query));
    }),
  );

  // Full-text search. Static path — Fastify routes it ahead of /v1/notes/:id.
  app.get(
    '/v1/notes/search',
    { ...guarded, config: routeRateLimit(SEARCH_RATE_LIMIT_MAX) },
    (req) =>
      tenant(req, async (ctx) => {
        requireScope(ctx, 'notes:read');
        const q = (req.query as { q?: string }).q ?? '';
        if (q.length > SEARCH_QUERY_MAX_LENGTH) {
          throw badRequest('Search query is too long', 'search_query_too_long');
        }
        return { query: q, results: await searchService.searchNotes(ctx, q) };
      }),
  );

  app.get('/v1/tags', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      return { tags: await searchService.listTags(ctx) };
    }),
  );

  app.get('/v1/notes/:id', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      return { note: await notesService.getNote(ctx, (req.params as { id: string }).id) };
    }),
  );

  app.post('/v1/notes', guarded, (req, reply) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:write');
      const note = await notesService.createNote(ctx, CreateNoteRequest.parse(req.body));
      reply.status(201);
      return { note };
    }),
  );

  app.patch('/v1/notes/:id', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:write');
      const note = await notesService.updateNote(
        ctx,
        (req.params as { id: string }).id,
        UpdateNoteRequest.parse(req.body),
      );
      return { note };
    }),
  );

  app.delete('/v1/notes/:id', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:write');
      const { baseVersion } = req.body as { baseVersion: number };
      const note = await notesService.deleteNote(
        ctx,
        (req.params as { id: string }).id,
        baseVersion,
      );
      return { note };
    }),
  );

  app.get('/v1/notes/:id/versions', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      const history = await notesService.listVersions(ctx, (req.params as { id: string }).id);
      return {
        versions: history.versions.map(serializeVersion),
        headVersion: history.headVersion,
        restoreProtocolVersion: RESTORE_PROTOCOL_VERSION,
      };
    }),
  );

  // Protocol-1 restore always revived a note and cannot safely interpret tombstone
  // snapshots. Keep the old path as an explicit no-mutation cutover for rolling clients.
  app.post('/v1/notes/:id/restore', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:write');
      throw new HttpError(
        428,
        'restore_protocol_upgrade_required',
        'Reload version history with a current Iris client before restoring',
      );
    }),
  );

  app.post('/v2/notes/:id/restore', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:write');
      if (
        !req.body ||
        typeof req.body !== 'object' ||
        !Object.prototype.hasOwnProperty.call(req.body, 'baseVersion')
      ) {
        throw new HttpError(
          428,
          'restore_precondition_required',
          'Reload version history with a current Iris client before restoring',
        );
      }
      const input = RestoreVersionRequest.parse(req.body);
      return notesService.restoreVersion(
        ctx,
        (req.params as { id: string }).id,
        input.versionId,
        input.baseVersion,
        input.preserveCurrentFolderIfUnknown,
        input.preserveCurrentDeletionStateIfUnknown,
      );
    }),
  );

  // ── Agents (token management is a user action) ─────────────────────────
  app.post('/v1/agents/tokens', guarded, (req, reply) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      const result = await agentService.issueAgentToken(
        ctx,
        IssueAgentTokenRequest.parse(req.body),
      );
      reply.status(201);
      return result;
    }),
  );

  app.get('/v1/agents/tokens', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      return { tokens: await agentService.listAgentTokens(ctx) };
    }),
  );

  app.delete('/v1/agents/tokens/:id', guarded, (req, reply) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      await agentService.revokeAgentToken(ctx, (req.params as { id: string }).id);
      reply.status(204);
      return null;
    }),
  );

  // ── Activity feed + undo (the soul of the product) ─────────────────────
  app.get('/v1/activity', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      return {
        activity: await activityService.listActivity(ctx),
        undoProtocolVersion: UNDO_PROTOCOL_VERSION,
      };
    }),
  );

  // As with restore, the legacy mutation path is intentionally inert during a rolling
  // protocol cutover. A v2 client routed to an old server receives 404; an old client
  // routed here receives 428. Neither mismatch can silently apply legacy semantics.
  app.post('/v1/activity/:id/undo', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      throw new HttpError(
        428,
        'undo_protocol_upgrade_required',
        'Reload activity with a current Iris client before undoing',
      );
    }),
  );

  app.post('/v2/activity/:id/undo', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      return activityService.undoActivity(ctx, (req.params as { id: string }).id);
    }),
  );

  // ── Sync ───────────────────────────────────────────────────────────────
  app.get('/v1/sync/changes', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      const query = SyncChangesRequest.parse(req.query);
      return syncService.syncChanges(ctx, query.since, query.deviceId);
    }),
  );

  app.post('/v1/sync/push', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:write');
      const body = SyncPushRequest.parse(req.body);
      return syncService.syncPush(ctx, body.deviceId, body.mutations);
    }),
  );

  // The additive generic boundary is intentionally note-only. `/v1` stays frozen so
  // mixed clients can replay the same receipt through either route without fallback.
  app.get('/v2/sync/changes', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      return syncV2Service.syncV2Changes(ctx, SyncV2ChangesRequest.parse(req.query));
    }),
  );

  app.post('/v2/sync/push', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:write');
      return syncV2Service.syncV2Push(ctx, SyncV2PushRequest.parse(req.body));
    }),
  );

  // ── Devices & billing ──────────────────────────────────────────────────
  app.post('/v1/devices', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      return deviceService.registerDevice(ctx, RegisterDeviceRequest.parse(req.body));
    }),
  );

  app.get('/v1/devices', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      return { devices: await deviceService.listDevices(ctx) };
    }),
  );

  // Deregister a device to free its plan slot (lost/reinstalled device recovery).
  app.delete('/v1/devices/:id', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      return deviceService.deregisterDevice(ctx, (req.params as { id: string }).id);
    }),
  );

  app.get('/v1/billing/status', guarded, (req) =>
    tenant(req, async (ctx) => billingService.billingStatus(ctx)),
  );

  app.post('/v1/billing/checkout', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      return billingService.createCheckout(ctx);
    }),
  );

  // Stripe webhook — no auth (Stripe calls it); the raw body is verified by the gateway.
  app.post('/v1/billing/webhook', async (req, reply) => {
    const sig = req.headers['stripe-signature'] as string | undefined;
    const event = await billingGateway().handleWebhook(req.rawBody ?? '', sig);
    if (event) await billingService.applySubscriptionEvent(app.db, event);
    return reply.send({ received: true });
  });

  // ── Account ────────────────────────────────────────────────────────────
  // Irreversible, operator-only account deletion (App Store 5.1.1(v) / GDPR erasure).
  app.delete('/v1/account', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      return accountService.deleteAccount(ctx, DeleteAccountRequest.parse(req.body));
    }),
  );

  // ── Export ─────────────────────────────────────────────────────────────
  // Spool the zip to a temp file inside a short read transaction, then stream that file to
  // the client. Notes are read in keyset-paged batches, so peak memory stays at ~one page
  // (the per-page `await` lets the zip writer drain to disk) rather than the whole workspace.
  // Streaming straight to the client would instead force a choice between buffering it all in
  // memory or holding the DB transaction open for the client's entire (slow) download — the
  // temp file avoids both (audit #6).
  app.get(
    '/v1/export',
    { ...guarded, config: routeRateLimit(EXPORT_RATE_LIMIT_MAX) },
    async (req, reply) => {
      const tmpPath = join(tmpdir(), `iris-export-${randomUUID()}.zip`);
      const archive = archiver('zip', { zlib: { level: 9 } });
      const out = createWriteStream(tmpPath);
      const spooled = new Promise<void>((resolve, reject) => {
        out.on('close', resolve);
        out.on('error', reject);
        archive.on('error', reject);
      });
      archive.pipe(out);
      try {
        await tenant(req, async (ctx) => {
          requireScope(ctx, 'notes:read');
          for await (const file of exportFiles(ctx)) {
            archive.append(file.content, { name: file.name });
          }
        });
        await archive.finalize();
        await spooled;
      } catch (err) {
        archive.destroy();
        await unlink(tmpPath).catch(() => undefined);
        throw err;
      }
      reply.header('content-type', 'application/zip');
      reply.header('content-disposition', 'attachment; filename="iris-export.zip"');
      const body = createReadStream(tmpPath);
      // The temp file has served its purpose once the response is drained (or the client
      // hangs up) — remove it either way so exports never accumulate on disk.
      const cleanup = (): void => void unlink(tmpPath).catch(() => undefined);
      body.on('close', cleanup);
      body.on('error', cleanup);
      return reply.send(body);
    },
  );

  return app;
}
