import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @always-on/server start:api',
      url: 'http://127.0.0.1:3001/api/health/live',
      timeout: 30_000,
    },
    {
      command: 'pnpm --filter @always-on/web dev:web',
      url: 'http://127.0.0.1:5173',
      timeout: 30_000,
    },
  ],
});
