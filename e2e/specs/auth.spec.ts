import { expect, test } from '@playwright/test';
import { e2eConfig, requireCredentials } from '../src/config.js';
import { MANAGED_LOGIN_URL } from '../src/managed_login.js';

test.describe('signed in', () => {
  test('the header shows the user, and signing out ends the session', async ({ page }) => {
    const { email } = requireCredentials(e2eConfig());
    const header = page.getByRole('banner');

    await page.goto('/');
    await expect(header.getByText(email)).toBeVisible();

    // Sign-out ends the managed login session and comes back to the home page. It only clears this test's
    // browser context, so the saved session other tests use stays valid.
    await header.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL((url) => url.origin === e2eConfig().baseUrl && url.pathname === '/');
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(header.getByText(email)).toHaveCount(0);

    await page.goto('/generate');
    await expect(page).toHaveURL(MANAGED_LOGIN_URL);
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a protected page redirects to sign-in', async ({ page }) => {
    await page.goto('/gallery');

    await expect(page).toHaveURL(MANAGED_LOGIN_URL);
    await expect(page.locator('input[name="username"]:visible')).toBeVisible();
  });
});
