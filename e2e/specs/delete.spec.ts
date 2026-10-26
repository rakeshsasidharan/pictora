import { expect, test } from '@playwright/test';
import { startMockImage, uniquePrompt } from '../src/generate.js';

// Deleting an image from the gallery (GAL-3).
test.describe('delete', () => {
  test('deletes an image and removes it from the gallery', async ({ page }) => {
    // A generate through the queue, the worker and the mock's delay.
    test.setTimeout(90_000);
    const prompt = uniquePrompt('A teapot on a windowsill');
    await startMockImage(page, prompt);
    await expect(page.getByText('Status: Done')).toBeVisible({ timeout: 60_000 });

    await page.goto('/gallery');
    const tile = page.getByRole('list', { name: 'Your images' }).getByRole('img', { name: prompt });
    await tile.click();
    const dialog = page.getByRole('dialog', { name: 'Image details' });
    const edit = dialog.getByRole('link', { name: 'Edit' });
    const imageId = /\/edit\/([0-9A-Z]{26})/.exec((await edit.getAttribute('href')) ?? '')?.[1];
    expect(imageId).toBeDefined();

    // The confirmation opens over the detail modal. Cancelling keeps the image.
    const confirm = page.getByRole('alertdialog', { name: 'Delete this image?' });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(confirm).toContainText("This can't be undone.");
    await confirm.getByRole('button', { name: 'Delete image' }).click();
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeHidden();
    await expect(tile).toHaveCount(0);

    // Gone for good: the API and the download link no longer find it.
    expect((await page.request.get(`/api/images/${imageId}`)).status()).toBe(404);
    const downloaded = await page.request.get(`/api/images/${imageId}/versions/1/download`, {
      maxRedirects: 0,
    });
    expect(downloaded.status()).toBe(404);
    await page.reload();
    await expect(
      page.getByRole('list', { name: 'Your images' }).getByRole('img', { name: prompt }),
    ).toHaveCount(0);
  });
});
