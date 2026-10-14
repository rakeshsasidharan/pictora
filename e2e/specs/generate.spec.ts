import { test } from '@playwright/test';
import { landsWith } from '../src/issues.js';

// The generate screen: prompt, style, size, quality and model, run with the mock provider (GEN-1 to GEN-10).
test.describe('generate', () => {
  test.fixme(
    'generates an image with the mock provider and shows the cost',
    landsWith(18),
    async ({ page }) => {
      await page.goto('/generate');
    },
  );
});
