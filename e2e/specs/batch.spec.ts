import { expect, test } from '@playwright/test';
import {
  chooseCount,
  chooseMock,
  openMore,
  scheduleButton,
  uniquePrompt,
  useOwnWords,
} from '../src/generate.js';

// Batch mode (P1, tech design 5.4): half the points, delivered later. The batch submitter and poller run every
// 15 minutes, longer than the suite's budget, so this covers scheduling; the Lambdas have their own tests.
test.describe('batch', () => {
  test('schedules a mock image at half the points and shows it as Scheduled in the gallery', async ({
    page,
  }) => {
    const prompt = uniquePrompt('A kite over the dunes');
    await page.goto('/generate');
    await useOwnWords(page);
    await page.getByRole('textbox', { name: 'Describe your image' }).fill(prompt);
    // Mock standard is 2 points an image: 4 for two, 2 delivered later.
    await chooseMock(page, 'Standard');
    await chooseCount(page, 2);
    await openMore(page);
    const later = page.getByRole('button', { name: 'Save points: deliver later' });
    await later.click();
    await expect(later).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(scheduleButton(page)).toHaveText('Schedule · 2 points');
    await expect(scheduleButton(page)).toHaveAccessibleDescription(
      /^Uses 2 of your \d+ points today \(half of 4, delivered later\)$/,
    );

    await scheduleButton(page).click();
    await expect(page.getByText('Status: Scheduled')).toBeVisible();

    await page.goto('/gallery');
    const grid = page.getByRole('list', { name: 'Your images' });
    const placeholder = grid.getByRole('listitem').filter({ hasText: prompt });
    await expect(placeholder.getByRole('status')).toHaveText('Scheduled · 2 images');
  });
});
