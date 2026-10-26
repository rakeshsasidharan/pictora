// @vitest-environment jsdom
import { loadSeedRegistry, TESTERS_GROUP } from '@pictora/core';
import { createRegistryLoader } from '@pictora/core/registry-store';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEADERS } from '../src/lib/session';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
const onboarded = vi.hoisted(() => ({ current: true }));
const pause = vi.hoisted(() => ({ current: undefined as { until: Date } | undefined }));
const rerun = vi.hoisted(() => ({
  settings: vi.fn<(deps: unknown, session: unknown, imageId: string) => Promise<unknown>>(),
}));

vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect to ${url}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

vi.mock('../src/lib/onboarding', () => ({
  requireOnboarding: async () => {
    if (!onboarded.current) throw new RedirectSignal('/onboarding');
  },
}));

// Dev's registry; Bedrock has no queue yet, so its models are left out.
vi.mock('../src/lib/registry', () => ({
  registryLoader: () =>
    createRegistryLoader({ source: async () => loadSeedRegistry(), environment: 'dev' }),
}));

vi.mock('../src/lib/jobs_deps', () => ({
  jobsDeps: () => ({ hasQueue: (provider: string) => provider !== 'bedrock', spendCapCents: 2000 }),
}));

vi.mock('../src/lib/dynamodb', () => ({
  documentClient: () => ({}),
  tableName: () => 'pictora-test',
}));

vi.mock('../src/lib/platform_spend', () => ({
  readPremiumPause: async () => pause.current,
}));

vi.mock('../src/lib/jobs', () => ({
  getMe: async () => ({ status: 200, body: { pointsLeft: 19, dailyLimit: 25 } }),
}));

vi.mock('../src/lib/images', () => ({ rerunSettings: rerun.settings }));

const { default: GeneratePage } = await import('../src/app/(app)/generate/page');

const page = (query: { rerun?: string } = {}) =>
  GeneratePage({ searchParams: Promise.resolve(query) });

/** Signs in as a tester by default, who is offered the Mock model like the e2e account. */
function signIn(groups: string[] = [TESTERS_GROUP]) {
  requestHeaders.current = new Headers({
    [SESSION_HEADERS.sub]: 'user-sub',
    [SESSION_HEADERS.email]: 'user@example.com',
    [SESSION_HEADERS.groups]: groups.join(','),
  });
}

describe('generate page', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers();
    onboarded.current = true;
    pause.current = undefined;
    rerun.settings.mockReset();
  });
  afterEach(cleanup);

  it('shows the form with the models that have a queue and today’s points', async () => {
    signIn();
    render(await page());
    expect(rerun.settings).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Create an image' })).toBeTruthy();
    expect(screen.getByText('19 of 25 points left today')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('radio', { name: /^Mock/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^GPT Image 2/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Stable Image Core/ })).toBeNull();
  });

  it('never offers the Mock model to a user outside the testers group', async () => {
    for (const groups of [[], ['admins']]) {
      signIn(groups);
      render(await page());
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
      expect(screen.queryByRole('radio', { name: /^Mock/ })).toBeNull();
      expect(screen.getByRole('radio', { name: /^GPT Image 2/ })).toBeTruthy();
      cleanup();
    }
  });

  it('disables premium qualities while the platform cap is reached', async () => {
    signIn();
    pause.current = { until: new Date('2026-11-01T00:00:00.000Z') };
    render(await page());
    expect(screen.getByText(/Premium models are paused until 1 November/)).toBeTruthy();
    const quality = screen.getByRole('combobox', { name: 'Quality' });
    expect(quality.textContent).toBe('Draft');
    fireEvent.keyDown(quality, { key: 'Enter' });
    const disabled = (name: RegExp) =>
      screen.getByRole('option', { name }).getAttribute('aria-disabled') === 'true';
    expect(disabled(/^Draft/)).toBe(false);
    expect(disabled(/^Standard/)).toBe(true);
    expect(disabled(/^High/)).toBe(true);
  });

  it('starts the form afresh when moving between a rerun and an empty form', async () => {
    signIn();
    rerun.settings.mockResolvedValue({
      prompt: 'A lighthouse at dusk',
      style: 'none',
      modelId: 'mock',
      quality: 'draft',
      aspect: '1:1',
    });
    // The page stays mounted when only the search changes, so the form's key follows the rerun.
    const empty = await page();
    const rerunForm = await page({ rerun: '01JAAAAAAAAAAAAAAAAAAAAAAA' });
    const otherRerun = await page({ rerun: '01JBBBBBBBBBBBBBBBBBBBBBBB' });
    expect(new Set([empty.key, rerunForm.key, otherRerun.key]).size).toBe(3);
    expect((await page()).key).toBe(empty.key);
  });

  it("fills the form with a gallery image's settings for a rerun", async () => {
    signIn();
    rerun.settings.mockResolvedValue({
      prompt: 'A lighthouse at dusk',
      style: 'watercolour',
      modelId: 'mock',
      quality: 'draft',
      aspect: '16:9',
      seed: 7,
    });
    render(await page({ rerun: '01JAAAAAAAAAAAAAAAAAAAAAAA' }));
    expect(rerun.settings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sub: 'user-sub' }),
      '01JAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Describe your image' }).value,
    ).toBe('A lighthouse at dusk');
    expect(screen.getByRole('combobox', { name: 'Aspect ratio' }).textContent).toBe('16:9');
    expect(screen.getByText(/Uses seed 7 from the original image/)).toBeTruthy();
  });

  it("starts empty when the image to rerun isn't the user's", async () => {
    signIn();
    rerun.settings.mockResolvedValue(undefined);
    render(await page({ rerun: '01JAAAAAAAAAAAAAAAAAAAAAAA' }));
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Describe your image' }).value,
    ).toBe('');
  });

  it('sends users who have not accepted the current terms to onboarding', async () => {
    signIn();
    onboarded.current = false;
    await expect(page()).rejects.toMatchObject({ url: '/onboarding' });
  });

  it('sends signed-out visitors home', async () => {
    await expect(page()).rejects.toMatchObject({ url: '/' });
  });
});
