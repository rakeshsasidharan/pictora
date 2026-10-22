import { expect, type Page } from '@playwright/test';

/**
 * Starts one draft image with the mock provider from the generate screen, in the user's own words, and returns
 * once the job is queued. Prompts carry a unique tag, so parallel tests find their own images.
 */
export async function startMockImage(page: Page, prompt: string): Promise<void> {
  await page.goto('/generate');
  const enhance = page.getByRole('checkbox', { name: /Enhance prompt/ });
  if (await enhance.isChecked()) await enhance.uncheck();
  await page.getByRole('textbox', { name: 'Describe your image' }).fill(prompt);
  await page.getByText('Advanced').click();
  await page.getByText('Mock (dev only)').click();
  await page.getByText('Draft', { exact: true }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText(/Status: (Queued|Generating|Done)/)).toBeVisible();
}

/** A prompt no other test run uses. */
export function uniquePrompt(subject: string): string {
  return `${subject} (e2e ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)})`;
}
