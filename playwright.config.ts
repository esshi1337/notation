import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Keep cleanup below the disposable mount points used by project checks.
  outputDir: './test-results/artifacts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.NOTATION_TEST_WORKERS ? Number(process.env.NOTATION_TEST_WORKERS) : process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/html' }]],
  use: {
    baseURL: 'http://127.0.0.1:1420',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
      },
    },
    // WebKit is the closest automatable stand-in for the macOS WKWebView. Its
    // Playwright build does not start on every Linux host, so the project is
    // opt-in; the macOS workflow enables it.
    ...(process.env.NOTATION_E2E_WEBKIT ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
  ],
  webServer: {
    command: 'node scripts/prepare-pdf-assets.mjs && npm --ignore-scripts run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
