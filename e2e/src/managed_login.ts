import { expect, type Page } from '@playwright/test';
import type { Credentials } from './config.js';

/**
 * Fills in Cognito's managed login page and submits it. The classic hosted UI renders the form twice (one copy
 * per screen size) and only one is visible, so the fields are matched by name among visible elements. The
 * newer managed login can ask for the email first and the password on a second step, which this also handles.
 */
export async function submitManagedLogin(page: Page, credentials: Credentials): Promise<void> {
  const username = page.locator('input[name="username"]:visible');
  await expect(username).toBeVisible();
  await username.fill(credentials.email);

  const password = page.locator('input[name="password"]:visible');
  if (!(await password.isVisible())) {
    await page.getByRole('button', { name: /^(next|continue)$/i }).click();
  }
  await expect(password).toBeVisible();
  await password.fill(credentials.password);
  await password.press('Enter');
}

/** The managed login page: Cognito's domain, which the app sends visitors to when they must sign in. */
export const MANAGED_LOGIN_URL = /^https:\/\/[^/]+\.amazoncognito\.com\//;
