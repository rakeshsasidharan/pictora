import { expect, test } from '@playwright/test';
import { chooseMock, generateButton, useOwnWords } from '../src/generate.js';

// Image tools (P1, tech design 5.5): the e2e account is a tester, so tools run on the Mock with no spend.
test.describe('image tools', () => {
  test('upscales an image into a new version from the Tools menu', async ({ page }) => {
    // A generate and an upscale, each through the queue, the worker and the mock's delay.
    test.setTimeout(150_000);
    await page.goto('/generate');
    await useOwnWords(page);
    await page
      .getByRole('textbox', { name: 'Describe your image' })
      .fill('A lighthouse on a cliff (e2e tools)');
    await chooseMock(page);
    await generateButton(page).click();
    await expect(page.getByText('Status: Done')).toBeVisible({ timeout: 60_000 });
    const edit = page.getByRole('list', { name: 'Results' }).getByRole('link', { name: 'Edit' });
    const imageId = /\/edit\/([0-9A-Z]{26})/.exec((await edit.getAttribute('href')) ?? '')?.[1];
    expect(imageId).toBeDefined();

    await page.goto(`/gallery/${imageId}`);
    await expect(page.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Upscale' }).click();
    const dialog = page.getByRole('dialog', { name: 'Upscale' });
    await expect(dialog.getByRole('radio', { name: /^Fast/ })).toBeChecked();
    // The cost is shown before the tool runs: the Mock's price for the tester account.
    await expect(dialog.getByText(/^Costs 1 point of your \d+ points left today\.$/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Run · 1 point' }).click();

    // The view moves to the new version once the job is done; the mock doubles each side.
    await expect(page.getByRole('heading', { name: 'Version 2', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(dialog).toBeHidden();
    const details = page.locator('[data-slot="detail-fields"]');
    await expect(details).toContainText('Fast upscale');
    await expect(details).toContainText('Version 1');
    await expect(details).toContainText('2048 × 2048');
  });
});
