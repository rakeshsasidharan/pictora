import { expect, test, type Page } from '@playwright/test';
import { VIEWPORTS, expectNoSeriousViolations, horizontalOverflow } from '../src/accessibility.js';
import { startMockImage, uniquePrompt } from '../src/generate.js';

/** The signed-in screens, each with its page heading. */
const SIGNED_IN_PAGES = [
  ['generate', '/generate', 'Create an image'],
  ['gallery', '/gallery', 'Your images'],
  ['edit', '/edit', 'Edit an image'],
  ['account', '/account', 'Account'],
] as const;

/** The signed-out pages, each with its page heading. */
const SIGNED_OUT_PAGES = [
  ['landing', '/', 'Turn your ideas into images'],
  ['terms', '/terms', 'Terms of service'],
] as const;

async function open(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
  // Lists and points load in the browser; check the page once they are in.
  await page.waitForLoadState('networkidle');
}

// WCAG 2.2 AA with axe, and the layout from 360 px phones to desktop (#30).
test.describe('accessibility', () => {
  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    for (const [name, path, heading] of SIGNED_OUT_PAGES) {
      test(`the ${name} page has no serious or critical axe violations`, async ({ page }) => {
        await open(page, path, heading);
        await expectNoSeriousViolations(page);
      });
    }

    test('the signed-out pages fit 360, 768 and 1280 px with no horizontal scroll', async ({
      page,
    }) => {
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        for (const [, path, heading] of SIGNED_OUT_PAGES) {
          await open(page, path, heading);
          expect(
            await horizontalOverflow(page),
            `${path} at ${viewport.width} px`,
          ).toBeLessThanOrEqual(0);
        }
      }
    });
  });

  for (const [name, path, heading] of SIGNED_IN_PAGES) {
    test(`the ${name} page has no serious or critical axe violations`, async ({ page }) => {
      await open(page, path, heading);
      await expectNoSeriousViolations(page);
    });
  }

  test('the signed-in pages fit 360, 768 and 1280 px with no horizontal scroll', async ({
    page,
  }) => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const [, path, heading] of SIGNED_IN_PAGES) {
        await open(page, path, heading);
        expect(
          await horizontalOverflow(page),
          `${path} at ${viewport.width} px`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  test('a new image, its edit panel and its detail page have no serious or critical axe violations', async ({
    page,
  }) => {
    // A generate through the queue, the worker and the mock's delay.
    test.setTimeout(90_000);
    const prompt = uniquePrompt('A kite over a beach');
    await startMockImage(page, prompt);
    await expect(page.getByText('Status: Done')).toBeVisible({ timeout: 60_000 });
    await expectNoSeriousViolations(page);

    await page.getByRole('list', { name: 'Results' }).getByRole('link', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Edit image' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoSeriousViolations(page);

    const imageId = /\/edit\/([0-9A-Z]{26})/.exec(page.url())?.[1];
    expect(imageId).toBeDefined();
    await open(page, `/gallery/${imageId}`, prompt);
    // The picture's alt text is the prompt.
    await expect(page.getByRole('img', { name: prompt })).toBeVisible();
    await expectNoSeriousViolations(page);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const path of [`/edit/${imageId}`, `/gallery/${imageId}`]) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        expect(
          await horizontalOverflow(page),
          `${path} at ${viewport.width} px`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });
});
