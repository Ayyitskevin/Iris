import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file gets a fresh in-process PGlite database, so run files in
    // isolation but tests within a file sequentially (they share one DB).
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Force the PGlite + local-auth + fake-Stripe path regardless of the host env.
    env: { NODE_ENV: 'test', DATABASE_URL: '', STRIPE_SECRET_KEY: '', JWT_SECRET: 'test-secret' },
  },
});
