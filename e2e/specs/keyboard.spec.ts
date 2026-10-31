import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { arrowTo, pressUntilFocused, tabTo } from '../src/accessibility.js';
import { uniquePrompt } from '../src/generate.js';

/** The first bytes of every PNG file. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Opens a select from the keyboard and picks the option, moving up and then down through the list. */
async function chooseWithKeyboard(page: Page, select: Locator, option: RegExp): Promise<void> {
  await tabTo(page, select);
  await page.keyboard.press('Enter');
  const wanted = page.getByRole('option', { name: option });
  await expect(wanted).toBeVisible();
  // The list opens on the current choice, so the option is above or below it.
  if (!(await pressUntilFocused(page, wanted, 'ArrowUp', 20))) {
    await arrowTo(page, wanted, 'ArrowDown');
  }
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeHidden();
}

/** Presses Enter on a download link and checks that it saves version `version` as a PNG. */
async function downloadWithKeyboard(page: Page, link: Locator, version: number): Promise<void> {
  await tabTo(page, link);
  const download = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const file = await download;
  expect(file.suggestedFilename()).toMatch(new RegExp(`^pictora-.+-v${version}\\.png$`));
  const bytes = await readFile(await file.path());
  expect([...bytes.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
}

// A full generate → edit → download flow with the keyboard alone (#30). No clicks: every control is reached
// with Tab or the arrow keys.
test.describe('keyboard only', () => {
  test('generates, downloads, edits and downloads the edit without a mouse', async ({ page }) => {
    // A generate and an edit through the queue, the worker and the mock's delay.
    test.setTimeout(180_000);
    const prompt = uniquePrompt('A lantern on a jetty');
    await page.goto('/generate');
    // The Enhance toggle's stored setting applies once the page hydrates (#151).
    await page.waitForLoadState('networkidle');

    const enhance = page.getByRole('button', { name: 'Enhance prompt' });
    await tabTo(page, enhance);
    if ((await enhance.getAttribute('aria-pressed')) === 'true') await page.keyboard.press('Space');
    await expect(enhance).toHaveAttribute('aria-pressed', 'false');

    // The model picker: a popover with the models as a toggle group.
    await tabTo(page, page.getByRole('button', { name: /^Model:/ }));
    await page.keyboard.press('Enter');
    const mock = page.getByRole('radio', { name: /^Mock \(dev only\)/ });
    await arrowTo(page, mock, 'ArrowDown');
    await page.keyboard.press('Space');
    await expect(mock).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(mock).toBeHidden();

    await chooseWithKeyboard(page, page.getByRole('combobox', { name: 'Quality' }), /^Draft/);
    await expect(page.getByRole('combobox', { name: 'Quality' })).toHaveText('Draft');

    await tabTo(page, page.getByRole('textbox', { name: 'Describe your image' }));
    await page.keyboard.type(prompt);
    await tabTo(page, page.getByRole('button', { name: /^Generate · \d+ points?$/ }));
    await page.keyboard.press('Enter');

    // The live region says when the image is ready.
    const announcement = page.locator('[data-slot="job-announcement"]');
    await expect(announcement).toHaveText('1 image ready', { timeout: 60_000 });
    const results = page.getByRole('list', { name: 'Results' });
    await downloadWithKeyboard(page, results.getByRole('link', { name: 'Download PNG' }), 1);

    await tabTo(page, results.getByRole('link', { name: 'Edit' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Edit image' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    await chooseWithKeyboard(
      page,
      page.getByRole('combobox', { name: 'Model' }),
      /^Mock \(dev only\)/,
    );
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveText('Mock (dev only)');
    await chooseWithKeyboard(page, page.getByRole('combobox', { name: 'Quality' }), /^Draft/);
    await tabTo(page, page.getByRole('textbox', { name: 'Describe your change' }));
    await page.keyboard.type('make it night');
    await tabTo(page, page.getByRole('button', { name: 'Apply edit' }));
    await page.keyboard.press('Enter');

    await expect(page.locator('[data-slot="job-announcement"]')).toHaveText(
      'Your edited version is ready.',
      { timeout: 60_000 },
    );
    await expect(page.getByRole('button', { name: 'Version 2', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await downloadWithKeyboard(
      page,
      page
        .getByRole('group', { name: 'Image actions' })
        .getByRole('link', { name: 'Download PNG' }),
      2,
    );
  });
});
