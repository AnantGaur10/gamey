import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Per-test { timeout } options are not honored by this setup (verified
  // empirically: a 5s-timeout test sleeping 10s still passes), so the
  // ceiling lives here. Slow duel-flow tests need ~40s (full round + series
  // advance); fast tests are unaffected.
  timeout: 150000,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      slowMo: parseInt(process.env.SLOW_MO || '0'),
    },
  },

  projects: [
    {
      name: 'desktop-1920',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'desktop-1366',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    {
      name: 'desktop-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'mobile-800',
      use: { ...devices['Pixel 5'], viewport: { width: 800, height: 450 } },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
  },
});
