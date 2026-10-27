import { expect, test } from '@playwright/test';
import { e2eConfig, requireCredentials } from '../src/config.js';
import { startMockImage, uniquePrompt } from '../src/generate.js';

/** The cookie shadcn's sidebar keeps its expanded or collapsed state in; with none, it starts collapsed. */
const SIDEBAR_STATE_COOKIE = 'sidebar_state';

// The sidebar shell around every signed-in page (#107).
test.describe('app shell', () => {
  test('navigates between the signed-in pages by the sidebar', async ({ page }) => {
    await page.goto('/generate');
    const pages = page.getByRole('navigation', { name: 'Pages' });
    await expect(pages.getByRole('link', { name: 'Generate' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await pages.getByRole('link', { name: 'Gallery' }).click();
    await expect(page).toHaveURL(/\/gallery$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your images' })).toBeVisible();
    await expect(pages.getByRole('link', { name: 'Gallery' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await pages.getByRole('link', { name: 'Edit' }).click();
    await expect(page).toHaveURL(/\/edit$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Edit an image' })).toBeVisible();

    // The account page is in the user menu, not the page links (#124).
    await expect(pages.getByRole('link', { name: 'Account' })).toHaveCount(0);
    const { email } = requireCredentials(e2eConfig());
    await page.getByRole('button', { name: email }).click();
    await page.getByRole('menuitem', { name: 'Account' }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();

    // The test user is never an admin.
    await expect(pages.getByRole('link', { name: 'Admin' })).toHaveCount(0);

    // The sidebar has no New image button (#128); Generate opens an empty form.
    await expect(page.getByRole('link', { name: 'New image' })).toHaveCount(0);
    await pages.getByRole('link', { name: 'Generate' }).click();
    await expect(page).toHaveURL(/\/generate$/);
    await expect(page.getByRole('textbox', { name: 'Describe your image' })).toHaveValue('');
  });

  test('shows the Pictora icon, and the theme switcher at the right of the page header', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const sidebar = page.locator('[data-slot="sidebar"]');
    const logo = sidebar.locator('[data-slot="sidebar-header"] img').first();
    await expect(logo).toHaveAttribute('src', '/icons/icon_192.png');
    await expect
      .poll(() => logo.evaluate((image: { naturalWidth: number }) => image.naturalWidth))
      .toBeGreaterThan(0);

    const header = page.locator('[data-slot="sidebar-inset"] > header');
    const theme = header.getByRole('button', { name: 'Theme' });
    await expect(theme).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Theme' })).toHaveCount(0);
    // Right-aligned: the button ends within a few pixels of the header's right padding.
    const [headerBox, themeBox] = [await header.boundingBox(), await theme.boundingBox()];
    expect(headerBox && themeBox).toBeTruthy();
    expect(headerBox!.x + headerBox!.width - (themeBox!.x + themeBox!.width)).toBeLessThan(24);
  });

  test('floats, starts collapsed in a fresh session, and keeps the choice across reloads', async ({
    page,
  }) => {
    // A first visit: no sidebar_state cookie yet.
    await page.context().clearCookies({ name: SIDEBAR_STATE_COOKIE });
    await page.goto('/gallery');
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toHaveAttribute('data-variant', 'floating');
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');

    await page.keyboard.press('Control+b');
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');
    await page.reload();
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');
    await page.goto('/edit');
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');

    // The page header lines up with the floating panel: it starts where the sidebar's gap ends, with no overlap.
    const gap = await page.locator('[data-slot="sidebar-gap"]').boundingBox();
    const header = await page.locator('[data-slot="sidebar-inset"] > header').boundingBox();
    expect(gap && header).toBeTruthy();
    expect(Math.abs(header!.x - (gap!.x + gap!.width))).toBeLessThan(1);

    await page.keyboard.press('Control+b');
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    await page.reload();
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  });

  test('lists a new image in the history and opens its detail page', async ({ page, baseURL }) => {
    // A generate through the queue, the worker and the mock's delay.
    test.setTimeout(90_000);
    // The history shows only while the sidebar is expanded.
    await page.context().addCookies([{ name: SIDEBAR_STATE_COOKIE, value: 'true', url: baseURL! }]);
    const prompt = uniquePrompt('A kite over a beach');
    await startMockImage(page, prompt);
    await expect(page.getByText('Status: Done')).toBeVisible({ timeout: 60_000 });

    // Finishing the job refreshes the history, newest first.
    const history = page.getByRole('navigation', { name: 'History' });
    const entry = history.getByRole('link', { name: new RegExp(escapeRegExp(prompt)) });
    await expect(entry).toBeVisible();
    await expect(history.getByRole('link').first()).toHaveAccessibleName(
      new RegExp(escapeRegExp(prompt)),
    );

    await entry.click();
    await expect(page).toHaveURL(/\/gallery\/[0-9A-Z]{26}$/);
    await expect(page.getByRole('heading', { level: 1, name: prompt })).toBeVisible();
  });

  test.describe('on a 360 px screen', () => {
    test.use({ viewport: { width: 360, height: 740 } });

    test('opens the sidebar as a sheet and closes it after a link', async ({ page }) => {
      await page.goto('/gallery');
      await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(0);

      await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
      const sheet = page.getByRole('dialog', { name: 'Sidebar' });
      await expect(sheet).toBeVisible();
      await sheet
        .getByRole('navigation', { name: 'Pages' })
        .getByRole('link', { name: 'Edit' })
        .click();

      await expect(page).toHaveURL(/\/edit$/);
      await expect(sheet).toBeHidden();
    });
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
