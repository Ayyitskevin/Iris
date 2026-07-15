/**
 * The Iris API — one Fastify service, every route workspace-scoped (ADR-006). Built as
 * a factory so tests can spin it up against a fresh PGlite and the server entrypoint can
 * run it for real. Auth = user session JWT or agent token; both resolve to a Principal
 * bound to exactly one workspace.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import archiver from 'archiver';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  CreateNoteRequest,
  IssueAgentTokenRequest,
  RegisterDeviceRequest,
  RestoreVersionRequest,
  SignInRequest,
  SignUpRequest,
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
import { forbidden, HttpError, unauthorized } from './lib/errors';
import * as notesService from './services/notes';
import * as activityService from './services/activity';
import * as agentService from './services/agents';
import * as syncService from './services/sync';
import * as deviceService from './services/devices';
import * as billingService from './services/billing';
import { collectExport } from './services/export';
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

export function buildApp(bundle: DbBundle): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' },
  });

  app.decorate('db', bundle.db);
  app.decorate('dbKind', bundle.kind);

  // Keep the raw body around (Stripe webhook signature needs it) while still parsing JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.register(cors, { origin: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply
        .status(err.status)
        .send({ error: { code: err.code, message: err.message, conflict: err.conflict } });
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      return reply.status(400).send({ error: { code: 'validation_error', message } });
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

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/health', async () => ({ ok: true, db: app.dbKind }));

  // ── Auth ────────────────────────────────────────────────────────────────
  app.post('/v1/auth/sign-up', async (req, reply) => {
    const input = SignUpRequest.parse(req.body);
    const authed = await getAuthProvider().signUp(app.db, input);
    const token = await signSession({ sub: authed.userId, wid: authed.workspaceId });
    return reply.status(201).send(await buildAuthResponse(authed, token));
  });

  app.post('/v1/auth/sign-in', async (req) => {
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
      return { notes: await notesService.listNotes(ctx) };
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
      const note = await notesService.deleteNote(ctx, (req.params as { id: string }).id, baseVersion);
      return { note };
    }),
  );

  app.get('/v1/notes/:id/versions', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      const versions = await notesService.listVersions(ctx, (req.params as { id: string }).id);
      return { versions: versions.map(serializeVersion) };
    }),
  );

  app.post('/v1/notes/:id/restore', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:write');
      const { versionId } = RestoreVersionRequest.parse(req.body);
      const note = await notesService.restoreVersion(ctx, (req.params as { id: string }).id, versionId);
      return { note };
    }),
  );

  // ── Agents (token management is a user action) ─────────────────────────
  app.post('/v1/agents/tokens', guarded, (req, reply) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      const result = await agentService.issueAgentToken(ctx, IssueAgentTokenRequest.parse(req.body));
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
      return { activity: await activityService.listActivity(ctx) };
    }),
  );

  app.post('/v1/activity/:id/undo', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      return activityService.undoActivity(ctx, (req.params as { id: string }).id);
    }),
  );

  // ── Sync ───────────────────────────────────────────────────────────────
  app.get('/v1/sync/changes', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      const q = req.query as { since?: string; deviceId?: string };
      return syncService.syncChanges(ctx, q.since ?? '', q.deviceId ?? 'default');
    }),
  );

  app.post('/v1/sync/push', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:write');
      const body = req.body as { deviceId: string; mutations: Parameters<typeof syncService.syncPush>[2] };
      return syncService.syncPush(ctx, body.deviceId, body.mutations);
    }),
  );

  // ── Devices & billing ──────────────────────────────────────────────────
  app.post('/v1/devices', guarded, (req) =>
    tenant(req, async (ctx) => {
      requireUser(ctx.principal);
      return deviceService.registerDevice(ctx, RegisterDeviceRequest.parse(req.body));
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

  // ── Export ─────────────────────────────────────────────────────────────
  app.get('/v1/export', guarded, async (req, reply) => {
    const files = await tenant(req, async (ctx) => {
      requireScope(ctx, 'notes:read');
      return collectExport(ctx);
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', 'attachment; filename="iris-export.zip"');
    for (const f of files) archive.append(f.content, { name: f.name });
    void archive.finalize();
    return reply.send(archive);
  });

  return app;
}
