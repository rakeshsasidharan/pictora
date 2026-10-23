import { expect, test as setup } from '@playwright/test';
import { e2eConfig, requireCredentials } from '../src/config.js';
import { submitManagedLogin } from '../src/managed_login.js';
import { completeOnboarding } from '../src/onboarding.js';
import { SESSION_STATE_PATH } from '../src/session_state.js';

/** Signs the Cognito test user in once and saves the session for every test that needs one. */
setup('sign in as the test user', async ({ page }) => {
  const config = e2eConfig();
  const credentials = requireCredentials(config);

  await page.goto('/');
  await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
  await submitManagedLogin(page, credentials);

  // The callback sets the session cookies and returns to the site.
  await page.waitForURL(
    (url) => url.origin === config.baseUrl && !url.pathname.startsWith('/auth/'),
  );
  // Onboarding shows the email in the site header, every other signed-in page in the sidebar's user menu.
  await expect(page.getByText(credentials.email).first()).toBeVisible();

  // A new test user, or one after the terms changed, lands on onboarding first (AUTH-4) and goes through it.
  if (new URL(page.url()).pathname === '/onboarding') {
    await completeOnboarding(page);
  }

  await page.context().storageState({ path: SESSION_STATE_PATH });
});
