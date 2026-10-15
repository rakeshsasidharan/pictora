import { test } from '@playwright/test';
import { landsWith } from '../src/issues.js';

// The private gallery and its detail view (GAL-1 to GAL-3).
test.describe('gallery', () => {
  test.fixme(
    'lists generated images newest first and opens the detail view',
    landsWith(23),
    async ({ page }) => {
      await page.goto('/gallery');
    },
  );
});
