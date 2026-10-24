import { expect, test } from '@playwright/test';
import { e2eConfig, requireCredentials } from '../src/config.js';
import { MANAGED_LOGIN_URL } from '../src/managed_login.js';

test.describe('signed in', () => {
  test('the user menu shows the user, and signing out ends the session', async ({ page }) => {
    const { email } = requireCredentials(e2eConfig());

    await page.goto('/');
    await expect(page).toHaveURL(/\/generate$/);
    const userMenu = page.getByRole('button', { name: email });
    await expect(userMenu).toBeVisible();

    // Sign-out ends the managed login session and comes back to the home page. It only clears this test's
    // browser context, so the saved session other tests use stays valid.
    await userMenu.click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL((url) => url.origin === e2eConfig().baseUrl && url.pathname === '/');
    const header = page.getByRole('banner');
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);

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
