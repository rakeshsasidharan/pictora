import { test } from '@playwright/test';
import { landsWith } from '../src/issues.js';

// Editing a gallery image with a prompt, with version history (EDIT-1 to EDIT-5).
test.describe('edit', () => {
  test.fixme(
    'edits an image with a prompt and keeps the original as a version',
    landsWith(22),
    async ({ page }) => {
      await page.goto('/gallery');
    },
  );
});
