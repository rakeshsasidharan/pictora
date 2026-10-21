import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { expectStaticImagesLoaded } from '../src/images.js';

/** The first bytes of every PNG file. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pointsLeft(text: string | null): number {
  const match = /^(\d+) of \d+ points left today$/.exec(text ?? '');
  if (!match?.[1]) throw new Error(`Unexpected points display: ${text}`);
  return Number(match[1]);
}

// The generate screen: prompt, style, size, quality and model, run with the mock provider (GEN-1 to GEN-10).
test.describe('generate', () => {
  test('the style picker shows a loaded sample thumbnail for every style but None', async ({
    page,
  }) => {
    await page.goto('/generate');
    // The thumbnails are decorative (empty alt text), so they are found inside the Style group.
    await expectStaticImagesLoaded(page.getByRole('group', { name: 'Style' }).locator('img'), 8);
  });

  test('generates two images with the mock provider, shows the cost and downloads a PNG', async ({
    page,
  }) => {
    // Queueing, the worker and the mock's delay take longer than one default test timeout.
    test.setTimeout(90_000);
    await page.goto('/generate');
    await expect(page.getByRole('heading', { name: 'Create an image' })).toBeVisible();
    const points = page.getByText(/points left today$/);
    const before = pointsLeft(await points.textContent());

    await page
      .getByRole('textbox', { name: 'Describe your image' })
      .fill('A lighthouse at dusk (e2e)');
    await page.getByText('Advanced').click();
    await page.getByText('Mock (dev only)').click();
    await expect(page.getByRole('radio', { name: /^Mock/ })).toBeChecked();
    await page.getByText('Draft', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Number of images' }).selectOption('2');
    await expect(page.getByText(`Uses 2 of your ${before} points today`)).toBeVisible();

    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(page.getByText('Status: Done')).toBeVisible({ timeout: 60_000 });

    const results = page.getByRole('list', { name: 'Results' });
    await expect(results.getByRole('listitem')).toHaveCount(2);
    // Two draft mock images cost a point each.
    await expect(points).toHaveText(new RegExp(`^${before - 2} of \\d+ points left today$`));

    const download = page.waitForEvent('download');
    await results.getByRole('link', { name: 'Download PNG' }).first().click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^pictora-.+-v1\.png$/);
    const bytes = await readFile(await file.path());
    expect([...bytes.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
  });
});
