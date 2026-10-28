import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Turns off the prompt enhancer, which is on by default (ENH-1), on the generate screen. Specs that don't test
 * the enhancer use it: each enhancer call counts toward the per-minute request limit, like a job (#115).
 */
export async function useOwnWords(page: Page): Promise<void> {
  await setEnhancer(page, false);
}

/** Turns the prompt enhancer on, if it is off. */
export async function useEnhancer(page: Page): Promise<void> {
  await setEnhancer(page, true);
}

/**
 * Sets the Enhance toggle, clicking until it stays as wanted. The server render shows it on, and hydration then
 * applies the setting stored by an earlier visit, so a single click can land as the toggle flips and undo it (#151).
 */
async function setEnhancer(page: Page, on: boolean): Promise<void> {
  // The server render already shows the toggle on, so wait for hydration before trusting it.
  await page.waitForLoadState('networkidle');
  const enhance = page.getByRole('button', { name: 'Enhance prompt' });
  const wanted = String(on);
  await expect(async () => {
    if ((await enhance.getAttribute('aria-pressed')) !== wanted) await enhance.click();
    await expect(enhance).toHaveAttribute('aria-pressed', wanted, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** The composer's send button, which carries the cost (for example `Generate · 2 points`). */
export function generateButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Generate · \d+ points?$/ });
}

/** The send button while "Save points: deliver later" is on. */
export function scheduleButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Schedule · \d+ points?$/ });
}

/** Opens More in the composer's settings row: transparent background, saving points and avoid. */
export async function openMore(page: Page): Promise<void> {
  const more = page.getByRole('button', { name: /^More options/ });
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}

/** Picks the Mock model in the model popover, then a quality in the composer's Quality select. */
export async function chooseMock(
  page: Page,
  quality: 'Draft' | 'Standard' = 'Draft',
): Promise<void> {
  await page.getByRole('button', { name: /^Model:/ }).click();
  const mock = page.getByRole('radio', { name: /^Mock \(dev only\)/ });
  await mock.click();
  await expect(mock).toBeChecked();
  await page.keyboard.press('Escape');
  const select = page.getByRole('combobox', { name: 'Quality' });
  await select.click();
  await page.getByRole('option', { name: new RegExp(`^${quality}`) }).click();
  await expect(select).toHaveText(quality);
}

/** Picks one image, or that many variations (up to 4), in the Variations select. */
export async function chooseCount(page: Page, count: number): Promise<void> {
  const label = count === 1 ? '1 image' : `${count} variations`;
  const select = page.getByRole('combobox', { name: 'Variations' });
  await select.click();
  await page.getByRole('option', { name: new RegExp(`^${label}`) }).click();
  await expect(select).toHaveText(label);
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
  await generateButton(page).click();
  await expect(page.getByText(/Status: (Queued|Generating|Done)/)).toBeVisible();
}

/** A prompt no other test run uses. */
export function uniquePrompt(subject: string): string {
  return `${subject} (e2e ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)})`;
}
