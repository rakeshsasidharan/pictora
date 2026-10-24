import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Turns off the prompt enhancer, which is on by default (ENH-1), on the generate screen. Specs that don't test
 * the enhancer use it: each enhancer call counts toward the per-minute request limit, like a job (#115).
 */
export async function useOwnWords(page: Page): Promise<void> {
  const enhance = page.getByRole('button', { name: 'Enhance prompt' });
  if ((await enhance.getAttribute('aria-pressed')) === 'true') await enhance.click();
  await expect(enhance).toHaveAttribute('aria-pressed', 'false');
}

/** Turns the prompt enhancer on, if it is off. */
export async function useEnhancer(page: Page): Promise<void> {
  const enhance = page.getByRole('button', { name: 'Enhance prompt' });
  if ((await enhance.getAttribute('aria-pressed')) !== 'true') await enhance.click();
  await expect(enhance).toHaveAttribute('aria-pressed', 'true');
}

/** Picks the Mock model in the Advanced popover, then a quality in the composer's Quality select. */
export async function chooseMock(
  page: Page,
  quality: 'Draft' | 'Standard' = 'Draft',
): Promise<void> {
  await page.getByRole('button', { name: 'Advanced' }).click();
  const mock = page.getByRole('radio', { name: /^Mock \(dev only\)/ });
  await mock.click();
  await expect(mock).toBeChecked();
  await page.keyboard.press('Escape');
  const select = page.getByRole('combobox', { name: 'Quality' });
  await select.click();
  await page.getByRole('option', { name: new RegExp(`^${quality}`) }).click();
  await expect(select).toHaveText(quality);
}

/** Picks how many images to make, from 1 to 4. */
export async function chooseCount(page: Page, count: number): Promise<void> {
  await page
    .getByRole('radiogroup', { name: 'Number of images' })
    .getByRole('radio', { name: `${count} ${count === 1 ? 'image' : 'images'}` })
    .click();
}

/** The generate thread's turns, oldest first: each a prompt with its options, then its job. */
export function threadTurns(page: Page): Locator {
  return page.getByRole('list', { name: 'Your requests' }).locator(':scope > li');
}

/**
 * Starts one draft image with the mock provider from the generate screen, in the user's own words, and returns
 * once the job is queued. Prompts carry a unique tag, so parallel tests find their own images.
 */
export async function startMockImage(page: Page, prompt: string): Promise<void> {
  await page.goto('/generate');
  await useOwnWords(page);
  await page.getByRole('textbox', { name: 'Describe your image' }).fill(prompt);
  await chooseMock(page);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText(/Status: (Queued|Generating|Done)/)).toBeVisible();
}

/** A prompt no other test run uses. */
export function uniquePrompt(subject: string): string {
  return `${subject} (e2e ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)})`;
}
