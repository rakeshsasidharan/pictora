import { defineConfig, devices } from '@playwright/test';
import { e2eConfig } from './src/config.js';
import { SESSION_STATE_PATH } from './src/session_state.js';

// Fails before any test runs when the base URL is prod or an unknown host.
const { baseUrl } = e2eConfig();
const ci = Boolean(process.env.CI);

/**
 * End-to-end suite run against dev after every dev deploy (tech design 13, CI/CD design 4.3). The `setup`
 * project signs in once and saves the session; the `chromium` project reuses it. The `cleanup` project is
 * setup's teardown: it runs once after every spec, passed or failed, and empties the test account's gallery.
 */
export default defineConfig({
  testDir: './specs',
  // CI uploads both folders when the run fails, so traces and screenshots land in them.
  outputDir: './test-results',
  reporter: [
    [ci ? 'github' : 'list'],
    ['html', { outputFolder: './playwright-report', open: 'never' }],
  ],
  fullyParallel: true,
  forbidOnly: ci,
  retries: 2,
  // The pipeline budgets four minutes for e2e (CI/CD design 4.3).
  globalTimeout: 4 * 60_000,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts$/,
      teardown: 'cleanup',
      use: {
        ...devices['Desktop Chrome'],
        // No trace of the step that types the test user's password.
        trace: 'off',
      },
    },
    {
      name: 'cleanup',
      testMatch: /.*\.teardown\.ts$/,
      use: { storageState: SESSION_STATE_PATH },
    },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: SESSION_STATE_PATH,
      },
    },
  ],
});
