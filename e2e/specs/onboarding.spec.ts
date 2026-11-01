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
    await page.getByRole('button', { name: email }).click();
    await page.getByRole('menuitem', { name: 'Account' }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.getByText('Email and password')).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();

    // The legal links and contact email are in their own card, and there is no site footer (#161).
    await expect(page.getByRole('heading', { name: 'Legal and support' })).toBeVisible();
    const legal = page.getByRole('main').getByRole('navigation', { name: 'Legal' });
    for (const [name, href] of [
      ['Terms of service', '/terms'],
      ['Content policy', '/content-policy'],
      ['Privacy policy', '/privacy'],
    ] as const) {
      await expect(legal.getByRole('link', { name: new RegExp(`^${name}`) })).toHaveAttribute(
        'href',
        href,
      );
    }
    await expect(
      page.getByRole('link', { name: /^Questions, feedback or a problem to report/ }),
    ).toHaveAttribute('href', /^mailto:/);
    await expect(page.getByRole('contentinfo')).toHaveCount(0);

    // The confirmation is an alert dialog (#110).
    await page.getByRole('button', { name: 'Delete account' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Are you sure?' });
    const confirm = dialog.getByRole('button', { name: 'Delete my account' });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox', { name: /Type DELETE to confirm/ }).fill('DELETE');
    await expect(confirm).toBeEnabled();
    // Cancel: deleting would remove the shared test user.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('the account page opens each legal page', async ({ page }) => {
    for (const [name, path, heading] of [
      ['Terms of service', '/terms', /Terms of service/],
      ['Content policy', '/content-policy', /Content policy/],
      ['Privacy policy', '/privacy', /Privacy policy/],
    ] as const) {
      await page.goto('/account');
      await page
        .getByRole('main')
        .getByRole('navigation', { name: 'Legal' })
        .getByRole('link', { name: new RegExp(`^${name}`) })
        .click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    }
  });
});
