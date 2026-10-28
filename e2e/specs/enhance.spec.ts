import { expect, test } from '@playwright/test';
import { chooseMock, generateButton, threadTurns, useEnhancer } from '../src/generate.js';

/** What the dev enhancer (`ENHANCER_MODEL=mock`) adds to every prompt. */
const MOCK_DETAIL = 'detailed composition, balanced framing, soft natural lighting, rich colour';

// The prompt enhancer with the mock enhancer in dev, then generating from its output (ENH-1, ENH-2).
test.describe('prompt enhancer', () => {
  test('enhances the prompt, generates from it, and regenerates from an edit', async ({ page }) => {
    // Two mock jobs run one after the other.
    test.setTimeout(120_000);
    await page.goto('/generate');
    await useEnhancer(page);

    await page
      .getByRole('textbox', { name: 'Describe your image' })
      .fill('A red kite over hills (e2e)');
    await chooseMock(page);

    const jobs: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/jobs') && request.method() === 'POST') {
        jobs.push(request.postDataJSON() as Record<string, unknown>);
      }
    });

    await generateButton(page).click();
    const turns = threadTurns(page);
    // The enhanced prompt sits collapsed in its turn.
    const toggle = turns.nth(0).getByRole('button', { name: 'Enhanced prompt' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    const enhanced = page.getByRole('textbox', { name: 'Enhanced prompt' });
    await expect(enhanced).toHaveValue(`A red kite over hills (e2e), ${MOCK_DETAIL}`);
    await expect(turns.nth(0).getByText('Status: Done')).toBeVisible({ timeout: 60_000 });
    expect(jobs[0]).toMatchObject({
      prompt: 'A red kite over hills (e2e)',
      enhancedPrompt: `A red kite over hills (e2e), ${MOCK_DETAIL}`,
    });

    await enhanced.fill('A red kite over green hills at noon (e2e)');
    const second = page.waitForResponse(
      (response) => response.url().endsWith('/api/jobs') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Regenerate with this prompt' }).click();
    await second;
    // The new job joins the thread below the finished one.
    await expect(turns).toHaveCount(2);
    await expect(turns.nth(1).getByText('Status: Done')).toBeVisible({ timeout: 60_000 });
    expect(jobs[1]).toMatchObject({ enhancedPrompt: 'A red kite over green hills at noon (e2e)' });
  });

  test('"Use my words" sends the exact prompt', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/generate');
    await useEnhancer(page);
    await page.getByRole('textbox', { name: 'Describe your image' }).fill('A blue door (e2e)');
    await chooseMock(page);

    await generateButton(page).click();
    await expect(page.getByText('Status: Done')).toBeVisible({ timeout: 60_000 });
    await threadTurns(page).nth(0).getByRole('button', { name: 'Enhanced prompt' }).click();
    await expect(page.getByRole('textbox', { name: 'Enhanced prompt' })).toBeVisible();

    await page.getByRole('button', { name: 'Use my words' }).click();
    await expect(page.getByRole('button', { name: 'Enhance prompt' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    const job = page.waitForRequest(
      (request) => request.url().endsWith('/api/jobs') && request.method() === 'POST',
    );
    await generateButton(page).click();
    const body = (await job).postDataJSON() as Record<string, unknown>;
    expect(body.prompt).toBe('A blue door (e2e)');
    expect(body).not.toHaveProperty('enhancedPrompt');
    await expect(page.getByRole('textbox', { name: 'Enhanced prompt' })).toBeHidden();
  });
});
