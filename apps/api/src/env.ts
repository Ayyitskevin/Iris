/**
 * Environment configuration. The foundation is designed to boot with NOTHING set:
 * no DATABASE_URL → PGlite; no STRIPE key → fake Stripe; no JWT_SECRET → a dev secret.
 * Every fallback here is dev-only and loudly documented.
 */
import { randomBytes } from 'node:crypto';

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

const jwtSecret = optional('JWT_SECRET');
if (!jwtSecret && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(optional('PORT') ?? 4000),
  apiBaseUrl: optional('API_BASE_URL') ?? 'http://localhost:4000',

  /** If set, use node-postgres against this cluster; else PGlite (ADR-002). */
  databaseUrl: optional('DATABASE_URL'),
  pglitePath: optional('PGLITE_PATH') ?? '.data/iris',

  authProvider: (optional('AUTH_PROVIDER') ?? 'local') as 'local' | 'clerk' | 'supabase',
  // Dev-only random secret so sessions work out of the box; NOT stable across restarts.
  jwtSecret: jwtSecret ?? `dev-${randomBytes(24).toString('hex')}`,

  stripe: {
    secretKey: optional('STRIPE_SECRET_KEY'),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET'),
    priceId: optional('STRIPE_PRICE_ID') ?? 'price_dev_sync',
    successUrl: optional('STRIPE_SUCCESS_URL') ?? 'iris://billing/success',
    cancelUrl: optional('STRIPE_CANCEL_URL') ?? 'iris://billing/cancel',
  },
} as const;

export type Env = typeof env;
