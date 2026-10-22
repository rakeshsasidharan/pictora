import { expect, type Page } from '@playwright/test';

/**
 * Turns off the prompt enhancer, which is on by default (ENH-1), on the generate screen. Specs that don't test
 * the enhancer use it: each enhancer call counts toward the per-minute request limit, like a job (#115).
 */
export async function useOwnWords(page: Page): Promise<void> {
  const enhance = page.getByRole('checkbox', { name: /Enhance prompt/ });
  if (await enhance.isChecked()) await enhance.uncheck();
}

/**
 * Starts one draft image with the mock provider from the generate screen, in the user's own words, and returns
 * once the job is queued. Prompts carry a unique tag, so parallel tests find their own images.
 */
export async function startMockImage(page: Page, prompt: string): Promise<void> {
  await page.goto('/generate');
  await useOwnWords(page);
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
