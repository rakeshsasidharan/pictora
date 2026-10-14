import { test } from '@playwright/test';
import { landsWith } from '../src/issues.js';

// Deleting an image from the gallery (GAL-3).
test.describe('delete', () => {
  test.fixme(
    'deletes an image and removes it from the gallery',
    landsWith(23),
    async ({ page }) => {
      await page.goto('/gallery');
    },
  );
});
