import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  chooseCount,
  chooseMock,
  threadTurns,
  uniquePrompt,
  useOwnWords,
} from '../src/generate.js';
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
    await page.getByRole('button', { name: /^Style:/ }).click();
    // The thumbnails are decorative (empty alt text), so they are found inside the Style group.
    await expectStaticImagesLoaded(
      page.getByRole('radiogroup', { name: 'Style' }).locator('img'),
      8,
    );
  });

  test('generates two images with the mock provider, shows the cost and downloads a PNG', async ({
    page,
  }) => {
    // Queueing, the worker and the mock's delay take longer than one default test timeout.
    test.setTimeout(90_000);
    await page.goto('/generate');
    await expect(page.getByRole('heading', { name: 'Create an image' })).toBeVisible();
    // The enhancer has its own spec.
    await useOwnWords(page);
    // The sidebar shows the points too; this is the generate screen's own line.
    const points = page.getByRole('main').getByText(/points left today$/);
    const before = pointsLeft(await points.textContent());

    await page
      .getByRole('textbox', { name: 'Describe your image' })
      .fill('A lighthouse at dusk (e2e)');
    await chooseMock(page);
    await chooseCount(page, 2);
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

  test('keeps two requests and their results in one thread', async ({ page }) => {
    // Two mock jobs run one after the other.
    test.setTimeout(120_000);
    const first = uniquePrompt('A red umbrella in the rain');
    const second = uniquePrompt('A green bicycle by a canal');
    await page.goto('/generate');
    await useOwnWords(page);
    await chooseMock(page);
    const composer = page.getByRole('textbox', { name: 'Describe your image' });

    await composer.fill(first);
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    const turns = threadTurns(page);
    await expect(turns.nth(0).getByText('Status: Done')).toBeVisible({ timeout: 60_000 });

    // Enter sends the next prompt.
    await composer.fill(second);
    await composer.press('Enter');
    await expect(turns).toHaveCount(2);
    await expect(turns.nth(1).getByText('Status: Done')).toBeVisible({ timeout: 60_000 });

    await expect(turns.nth(0).getByText(first, { exact: true })).toBeVisible();
    await expect(turns.nth(0).getByRole('img', { name: first })).toHaveCount(1);
    await expect(turns.nth(1).getByText(second, { exact: true })).toBeVisible();
    await expect(turns.nth(1).getByRole('img', { name: second })).toHaveCount(1);
    await expect(turns.nth(1).getByRole('list', { name: 'Options' })).toContainText('Draft');
  });

  test('keeps the composer and its options reachable at 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/generate');
    // The sidebar is a sheet at this width, so the page has the full width.
    const composer = page.getByRole('textbox', { name: 'Describe your image' });
    await expect(composer).toBeInViewport();
    for (const control of [
      page.getByRole('button', { name: /^Style:/ }),
      page.getByRole('combobox', { name: 'Aspect ratio' }),
      page.getByRole('combobox', { name: 'Quality' }),
      page.getByRole('radiogroup', { name: 'Number of images' }),
      page.getByRole('button', { name: 'Advanced' }),
      page.getByRole('button', { name: 'Generate', exact: true }),
    ]) {
      await expect(control).toBeInViewport();
    }
    // Nothing scrolls sideways.
    const width = await page
      .locator('html')
      .evaluate(
        (html: { scrollWidth: number; clientWidth: number }) => html.scrollWidth - html.clientWidth,
      );
    expect(width).toBeLessThanOrEqual(0);
  });
});
