// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage from '../src/app/(site)/page';
import { SAMPLE_IMAGES } from '../src/lib/sample_images';
import { SESSION_HEADERS } from '../src/lib/session';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));

vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const onboarded = vi.hoisted(() => ({ current: true }));

// The home page reads the profile to choose between onboarding and the generate screen.
vi.mock('../src/lib/onboarding', () => ({
  signedInHome: async () => (onboarded.current ? '/generate' : '/onboarding'),
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect to ${url}`);
  }
}

// Next.js's redirect() throws to stop rendering; the stand-in does the same so the test can see where to.
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

/** The page's props with no query string, and with one. */
const NO_QUERY = { searchParams: Promise.resolve({}) };
const query = (params: Record<string, string>) => ({ searchParams: Promise.resolve(params) });

describe('landing page', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers();
  });
  afterEach(cleanup);

  it('shows signed-out visitors the pitch and a Start creating button that goes to sign-in', async () => {
    render(await HomePage(NO_QUERY));

    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    const ctas = screen.getAllByRole('link', { name: 'Start creating' });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      expect(cta.getAttribute('href')).toBe('/auth/login?returnTo=%2Fgenerate');
      expect(cta.getAttribute('data-slot')).toBe('button');
    }
  });

  it('shows a sample image for every entry in the manifest, with its style and prompt', async () => {
    render(await HomePage(NO_QUERY));

    const grid = screen.getByRole('list', { name: 'Sample images by style' });
    const items = within(grid).getAllByRole('listitem');
    expect(items).toHaveLength(SAMPLE_IMAGES.length);
    for (const sample of SAMPLE_IMAGES) {
      const image = within(grid).getByAltText(sample.alt);
      expect(image.getAttribute('src')).toBe(sample.src);
      expect(within(grid).getByText(sample.prompt)).toBeTruthy();
      expect(image.closest('[data-slot="card"]')).not.toBeNull();
    }
    expect(within(grid).getByText('Watercolour')).toBeTruthy();
  });

  it('explains how it works in three steps and that it is free with a daily allowance', async () => {
    render(await HomePage(NO_QUERY));

    const how = screen.getByRole('heading', { name: 'How it works' }).closest('section');
    expect(how).not.toBeNull();
    const steps = within(how!).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(
      steps.map((step) => within(step).getByRole('heading', { level: 3 }).textContent),
    ).toEqual(['Describe it', 'Pick a style', 'Refine and download']);
    expect(screen.getByRole('heading', { name: 'Free, with a daily allowance' })).toBeTruthy();
  });

  it('sends signed-in users who have been through onboarding to the generate screen', async () => {
    onboarded.current = true;
    requestHeaders.current = new Headers({
      [SESSION_HEADERS.sub]: 'user-sub',
      [SESSION_HEADERS.email]: 'user@example.com',
    });

    await expect(HomePage(NO_QUERY)).rejects.toThrow(RedirectSignal);
    await expect(HomePage(NO_QUERY)).rejects.toMatchObject({ url: '/generate' });
  });

  it('sends signed-in users who have not been through onboarding there first', async () => {
    onboarded.current = false;
    requestHeaders.current = new Headers({ [SESSION_HEADERS.sub]: 'new-user' });
    await expect(HomePage(NO_QUERY)).rejects.toMatchObject({ url: '/onboarding' });
  });
});

describe('landing page after a refused beta sign-up', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers();
  });
  afterEach(cleanup);

  it('explains that Pictora is in private beta and how to ask for an invite', async () => {
    render(await HomePage(query({ signin: 'private_beta' })));
    const notice = screen
      .getByText('Pictora is in private beta')
      .closest('[data-slot="beta-rejected"]') as HTMLElement;
    expect(notice.getAttribute('role')).toBe('alert');
    within(notice).getByText(/by invitation only/);
    expect(
      within(notice).getByRole('link', { name: 'contact@rpillai.dev' }).getAttribute('href'),
    ).toBe('mailto:contact@rpillai.dev');
    // The way in stays on the page.
    expect(screen.getAllByRole('link', { name: 'Start creating' }).length).toBeGreaterThan(0);
  });

  it('shows no notice otherwise', async () => {
    render(await HomePage(query({ signin: 'something-else' })));
    expect(screen.queryByText('Pictora is in private beta')).toBeNull();
  });
});
