import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { useOwnWords } from '../src/generate.js';

/** The first bytes of every PNG file. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Generates one draft image with the mock provider and opens its edit panel. */
async function openEditPanel(page: Page): Promise<void> {
  await page.goto('/generate');
  await useOwnWords(page);
  await page
    .getByRole('textbox', { name: 'Describe your image' })
    .fill('A harbour at dusk (e2e edit)');
  await page.getByText('Advanced').click();
  await page.getByText('Mock (dev only)').click();
  await page.getByText('Draft', { exact: true }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('Status: Done')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('list', { name: 'Results' }).getByRole('link', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit image' })).toBeVisible();
}

/** Edits the selected version with the mock model at draft quality and waits for version `expected`. */
async function applyEdit(page: Page, instruction: string, expected: number): Promise<void> {
  await page.getByRole('combobox', { name: 'Model' }).selectOption('mock');
  await page.getByText('Draft', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Describe your change' }).fill(instruction);
  await page.getByRole('button', { name: 'Apply edit' }).click();
  const created = page.getByRole('button', { name: `Version ${expected}` });
  await expect(created).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
}

// Editing an image with a prompt, with version history (EDIT-1 to EDIT-5).
test.describe('edit', () => {
  test('edits an image with a prompt and keeps the original as a version', async ({ page }) => {
    // A generate and three edits, each through the queue, the worker and the mock's delay.
    test.setTimeout(240_000);
    await openEditPanel(page);
    const versions = page.getByRole('list', { name: 'Versions' });
    await expect(versions.getByRole('listitem')).toHaveCount(1);

    await applyEdit(page, 'make it night', 2);
    await applyEdit(page, 'add stars', 3);
    const night = page.getByRole('button', { name: 'Version 2' });
    const stars = page.getByRole('button', { name: 'Version 3' });
    await expect(night).toContainText('make it night');
    await expect(night).toContainText('Edited from version 1');
    await expect(stars).toContainText('add stars');
    await expect(stars).toContainText('Edited from version 2');

    // Version 1 is still there and downloads as the original PNG.
    await page.getByRole('button', { name: 'Version 1' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download PNG' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^pictora-.+-v1\.png$/);
    const bytes = await readFile(await file.path());
    expect([...bytes.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);

    // Editing version 1 after version 3 creates version 4 with parent 1.
    await applyEdit(page, 'add snow', 4);
    await expect(page.getByRole('button', { name: 'Version 4' })).toContainText(
      'Edited from version 1',
    );
    await expect(versions.getByRole('listitem')).toHaveCount(4);
  });

  test("another user's image, or one that doesn't exist, is not found", async ({ page }) => {
    const response = await page.goto('/edit/01JAAAAAAAAAAAAAAAAAAAAAAA');
    expect(response?.status()).toBe(404);
  });
});
