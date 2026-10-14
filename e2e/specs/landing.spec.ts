import { test } from '@playwright/test';
import { landsWith } from '../src/issues.js';

// The signed-out landing page and the legal pages it links to.
test.describe('landing', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.fixme(
    'the signed-out landing page shows sample images and a call to action',
    landsWith(29),
    async ({ page }) => {
      await page.goto('/');
    },
  );

  test.fixme(
    'the footer links to /terms, /content-policy and /privacy',
    landsWith(29),
    async ({ page }) => {
      await page.goto('/');
    },
  );
});
