import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4197',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm browser:serve',
    url: 'http://127.0.0.1:4197',
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      EXPO_PUBLIC_DURABLE_STORAGE: '1',
      EXPO_PUBLIC_API_URL: 'http://127.0.0.1:9',
    },
  },
});
