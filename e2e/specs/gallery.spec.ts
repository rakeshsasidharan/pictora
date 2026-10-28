import { expect, test } from '@playwright/test';
import { startMockImage, uniquePrompt } from '../src/generate.js';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The private gallery and its detail view (GAL-1 to GAL-4, GEN-8).
test.describe('gallery', () => {
  test('lists a new image first, opens its detail view and reruns it', async ({ page }) => {
    // A generate through the queue, the worker and the mock's delay.
    test.setTimeout(90_000);
    const prompt = uniquePrompt('A paper boat on a pond');
    await startMockImage(page, prompt);

    // Leaving the generate screen: the job shows in the gallery while it runs, then as an image.
    await page.goto('/gallery');
    const grid = page.getByRole('list', { name: 'Your images' });
    const tile = grid.getByRole('img', { name: prompt });
    await expect(grid.getByText(prompt).or(tile)).toBeVisible();
    await expect(tile).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => tile.evaluate((image: { naturalWidth: number }) => image.naturalWidth))
      .toBeGreaterThan(0);

    // On a desktop screen the detail opens as a modal.
    await tile.click();
    const dialog = page.getByRole('dialog', { name: 'Image details' });
    await expect(dialog.getByRole('heading', { name: prompt })).toBeVisible();
    await expect(dialog.getByText('Mock (dev only)')).toBeVisible();
    await expect(dialog.getByText('Draft', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Seed', { exact: true })).toBeVisible();

    const download = page.waitForEvent('download');
    await dialog.getByRole('link', { name: 'Download PNG' }).click();
    expect((await download).suggestedFilename()).toMatch(/^pictora-.+-v1\.png$/);

    // Rerun opens the generate screen with the same settings and seed.
    await dialog.getByRole('link', { name: 'Rerun' }).click();
    await expect(page).toHaveURL(/\/generate\?rerun=/);
    await expect(page.getByRole('textbox', { name: 'Describe your image' })).toHaveValue(prompt);
    await expect(page.getByRole('combobox', { name: 'Quality' })).toHaveText('Draft');
    await expect(page.getByText(/Uses seed \d+ from the original image/)).toBeVisible();
  });

  test('the detail modal keeps its size with a long prompt, which scrolls in its own box (#145)', async ({
    page,
  }) => {
    // Two generates through the queue, the worker and the mock's delay.
    test.setTimeout(150_000);
    const short = uniquePrompt('A red kite over a beach');
    const tag = uniquePrompt('A lighthouse in a storm');
    const filler = ' with waves breaking on the rocks and gulls wheeling in the grey sky';
    const long = `${tag}${filler.repeat(40)}`.slice(0, 2000);
    expect(long).toHaveLength(2000);
    await startMockImage(page, short);
    await startMockImage(page, long);

    await page.goto('/gallery');
    const grid = page.getByRole('list', { name: 'Your images' });
    // The tile's alt text is the prompt, trimmed to 150 characters.
    const tiles = {
      short: grid.getByRole('img', { name: short }),
      long: grid.getByRole('img', { name: new RegExp(`^${escapeRegExp(tag)}`) }),
    };
    await expect(tiles.short).toBeVisible({ timeout: 60_000 });
    await expect(tiles.long).toBeVisible({ timeout: 60_000 });

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const { width, height } = viewport ?? { width: 0, height: 0 };
    const heights: number[] = [];
    for (const [name, tile] of Object.entries(tiles)) {
      await tile.click();
      const dialog = page.getByRole('dialog', { name: 'Image details' });
      await expect(dialog.getByRole('link', { name: 'Download PNG' })).toBeVisible();
      // Measure once the opening animation (a zoom) is over.
      await dialog.evaluate((element: { getAnimations(): { finished: Promise<unknown> }[] }) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      const box = await dialog.boundingBox();
      if (!box) throw new Error('The dialog has no box.');
      heights.push(box.height);
      // It fits the window, centred.
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      expect(Math.abs(box.y - (height - (box.y + box.height)))).toBeLessThanOrEqual(2);
      expect(Math.abs(box.x - (width - (box.x + box.width)))).toBeLessThanOrEqual(2);
      // Download stays in view without scrolling the dialog.
      await expect(dialog.getByRole('link', { name: 'Download PNG' })).toBeInViewport();

      const prompt = dialog.getByRole('group', { name: 'Prompt' });
      const scrolls = await prompt.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      );
      expect(scrolls).toBe(name === 'long');
      if (name === 'long') {
        // The long prompt scrolls inside its box, from the keyboard too.
        await prompt.focus();
        await page.keyboard.press('End');
        await expect.poll(() => prompt.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await expect(dialog.getByRole('link', { name: 'Download PNG' })).toBeInViewport();
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    // The same height with a 2,000-character prompt as with a short one.
    const [shortHeight, longHeight] = heights;
    expect(Math.abs((longHeight ?? 0) - (shortHeight ?? -10))).toBeLessThanOrEqual(1);
  });

  test("another user's image, or one that doesn't exist, is not found", async ({ page }) => {
    const response = await page.goto('/gallery/01JAAAAAAAAAAAAAAAAAAAAAAA');
    expect(response?.status()).toBe(404);
  });
});
