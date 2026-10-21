import { expect, test } from '@playwright/test';
import { expectStaticImagesLoaded } from '../src/images.js';
import { landsWith } from '../src/issues.js';

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

  test.fixme(
    'the footer links to /terms, /content-policy and /privacy',
    landsWith(29),
    async ({ page }) => {
      await page.goto('/');
    },
  );
});
