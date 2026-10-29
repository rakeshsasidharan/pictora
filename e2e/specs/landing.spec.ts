import { expect, test } from '@playwright/test';
import { expectStaticImagesLoaded } from '../src/images.js';

// The signed-out landing page and the legal pages it links to.
test.describe('landing', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the signed-out landing page shows sample images and a call to action', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Turn your ideas into images' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start creating' }).first()).toBeVisible();
    await expectStaticImagesLoaded(
      page.getByRole('list', { name: 'Sample images by style' }).getByRole('img'),
      8,
    );
  });

  test('the footer links to /terms, /content-policy and /privacy', async ({ page }) => {
    await page.goto('/');
    const legal = page.getByRole('contentinfo').getByRole('navigation', { name: 'Legal' });
    // Each page's title is its link's text.
    for (const [name, path] of [
      ['Terms of service', '/terms'],
      ['Content policy', '/content-policy'],
      ['Privacy policy', '/privacy'],
    ] as const) {
      await expect(legal.getByRole('link', { name })).toHaveAttribute('href', path);
      await legal.getByRole('link', { name }).click();
      await expect(page).toHaveURL(path);
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      await expect(page.getByRole('note')).toContainText('Draft, pending legal review');
    }
  });

  test('the landing page fits a 360 px screen with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Turn your ideas into images' })).toBeVisible();
    const width = await page
      .locator('html')
      .evaluate(
        (html: { scrollWidth: number; clientWidth: number }) => html.scrollWidth - html.clientWidth,
      );
    expect(width).toBeLessThanOrEqual(0);
  });
});
