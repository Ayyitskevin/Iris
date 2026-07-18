import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The billing gate is only as strong as the guarantee that the FAKE Stripe gateway never
 * runs in production — its webhook accepts unsigned events, so it would let anyone mark a
 * workspace premium. env.ts must fail fast at boot if live billing keys are missing in prod.
 */
const KEYS = [
  'NODE_ENV',
  'JWT_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'DATABASE_URL',
] as const;

const original: Record<string, string | undefined> = {};
for (const k of KEYS) original[k] = process.env[k];

function apply(overrides: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const k of KEYS) {
    if (k in overrides) {
      const v = overrides[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function loadEnv(overrides: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  vi.resetModules();
  apply(overrides);
  return import('../src/env');
}

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  vi.resetModules();
});

describe('env production guards', () => {
  it('refuses to boot in production without STRIPE_SECRET_KEY', async () => {
    await expect(
      loadEnv({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(32),
        STRIPE_SECRET_KEY: undefined,
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
      }),
    ).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });

  it('refuses to boot in production without STRIPE_WEBHOOK_SECRET', async () => {
    await expect(
      loadEnv({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(32),
        STRIPE_SECRET_KEY: 'sk_live_test',
        STRIPE_WEBHOOK_SECRET: undefined,
      }),
    ).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('still guards JWT_SECRET in production', async () => {
    await expect(
      loadEnv({
        NODE_ENV: 'production',
        JWT_SECRET: undefined,
        STRIPE_SECRET_KEY: 'sk_live_test',
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
      }),
    ).rejects.toThrow(/JWT_SECRET/);
  });

  it('boots in production when all required secrets are present', async () => {
    const mod = await loadEnv({
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(32),
      STRIPE_SECRET_KEY: 'sk_live_test',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      DATABASE_URL: 'postgres://localhost/iris',
    });
    expect(mod.env.isProduction).toBe(true);
    expect(mod.env.stripe.secretKey).toBe('sk_live_test');
    expect(mod.env.stripe.webhookSecret).toBe('whsec_test');
  });

  it('boots in development with nothing set (fake gateway is allowed off-prod)', async () => {
    const mod = await loadEnv({
      NODE_ENV: 'development',
      JWT_SECRET: undefined,
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
    });
    expect(mod.env.isProduction).toBe(false);
    expect(mod.env.stripe.secretKey).toBeUndefined();
  });
});
