import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { applyMigrationsPglite } from '../src/db/migrate';
import { createDb } from '../src/db/client';
import { buildApp } from '../src/app';

export interface TestApp {
  app: FastifyInstance;
  close: () => Promise<void>;
}

/** A fresh, isolated in-memory Postgres (PGlite) + a ready Fastify app per test file. */
export async function makeApp(): Promise<TestApp> {
  const client = new PGlite();
  await applyMigrationsPglite(client);
  const bundle = createDb(client);
  const app = buildApp(bundle);
  await app.ready();
  return {
    app,
    close: async () => {
      await app.close();
      await bundle.close();
    },
  };
}

export interface CallResult<T = any> {
  status: number;
  json: T;
}

/** Inject an HTTP request without opening a socket. */
export async function call<T = any>(
  app: FastifyInstance,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<CallResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const res = (await app.inject({
    method: method as any,
    url: path,
    headers,
    payload,
  })) as unknown as { statusCode: number; json: () => T };
  let json: T;
  try {
    json = res.json();
  } catch {
    json = undefined as T;
  }
  return { status: res.statusCode, json };
}

/** Sign up a fresh user; returns their session token + ids. */
export async function signUp(
  app: FastifyInstance,
  email = `u${randomUUID().slice(0, 8)}@example.com`,
): Promise<{ token: string; workspaceId: string; userId: string; email: string }> {
  const { status, json } = await call(app, 'POST', '/v1/auth/sign-up', {
    body: { email, password: 'correct-horse-battery', displayName: 'Test User' },
  });
  if (status !== 201) throw new Error(`sign-up failed: ${status} ${JSON.stringify(json)}`);
  return { token: json.token, workspaceId: json.workspace.id, userId: json.user.id, email };
}
