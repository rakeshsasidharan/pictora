import { expect, test } from '@playwright/test';
import { startMockImage, uniquePrompt } from '../src/generate.js';

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
    await expect(page.getByRole('radio', { name: /^Draft/ })).toBeChecked();
    await expect(page.getByText(/Uses seed \d+ from the original image/)).toBeVisible();
  });

  test("another user's image, or one that doesn't exist, is not found", async ({ page }) => {
    const response = await page.goto('/gallery/01JAAAAAAAAAAAAAAAAAAAAAAA');
    expect(response?.status()).toBe(404);
  });
});
