import { expect, test } from '@playwright/test';
import { e2eConfig, requireCredentials } from '../src/config.js';

// The setup project takes the test user through onboarding when it hasn't been (AUTH-4).
test.describe('onboarding', () => {
  test('an onboarded user goes from the home page and from /onboarding to the generate screen', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/generate$/);
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/generate$/);
  });

  test('the account page shows the user and the delete confirmation', async ({ page }) => {
    const { email } = requireCredentials(e2eConfig());
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: email }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.getByText('Email and password')).toBeVisible();

    await page.getByRole('button', { name: 'Delete account' }).click();
    const confirm = page.getByRole('button', { name: 'Delete my account' });
    await expect(confirm).toBeDisabled();
    await page.getByRole('textbox', { name: /Type DELETE to confirm/ }).fill('DELETE');
    await expect(confirm).toBeEnabled();
    // Cancel: deleting would remove the shared test user.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
  });
});
