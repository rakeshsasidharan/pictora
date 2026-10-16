import { expect, type Page } from '@playwright/test';

/** Ticks the age confirmation and the terms on `/onboarding` and continues to the generate screen (AUTH-4). */
export async function completeOnboarding(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: /13 years old or older/ }).check();
  await page.getByRole('checkbox', { name: /I accept the/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL((url) => url.pathname === '/generate');
  await expect(page).not.toHaveURL(/\/onboarding/);
}
