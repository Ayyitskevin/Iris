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

// The fake billing gateway accepts UNSIGNED webhook events, so it must never run in
// production: without a real Stripe secret, anyone could POST /v1/billing/webhook to mark any
// workspace premium for free. Require live billing keys in production (mirrors JWT_SECRET),
// so a misconfigured deploy fails fast instead of silently disabling the billing gate.
const stripeSecretKey = optional('STRIPE_SECRET_KEY');
const stripeWebhookSecret = optional('STRIPE_WEBHOOK_SECRET');
if (process.env.NODE_ENV === 'production') {
  if (!stripeSecretKey) throw new Error('STRIPE_SECRET_KEY must be set in production');
  if (!stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET must be set in production');
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
    secretKey: stripeSecretKey,
    webhookSecret: stripeWebhookSecret,
    priceId: optional('STRIPE_PRICE_ID') ?? 'price_dev_sync',
    successUrl: optional('STRIPE_SUCCESS_URL') ?? 'iris://billing/success',
    cancelUrl: optional('STRIPE_CANCEL_URL') ?? 'iris://billing/cancel',
  },
} as const;

export type Env = typeof env;
