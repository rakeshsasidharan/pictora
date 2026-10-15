// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage from '../src/app/page';
import { SAMPLE_IMAGES } from '../src/lib/sample_images';
import { SESSION_HEADERS } from '../src/lib/session';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));

vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

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

describe('landing page', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers();
  });
  afterEach(cleanup);

  it('shows signed-out visitors the pitch and a Start creating button that goes to sign-in', async () => {
    render(await HomePage());

    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    const ctas = screen.getAllByRole('link', { name: 'Start creating' });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      expect(cta.getAttribute('href')).toBe('/auth/login?returnTo=%2Fgenerate');
    }
  });

  it('shows a sample image for every entry in the manifest, with its style and prompt', async () => {
    render(await HomePage());

    const grid = screen.getByRole('list', { name: 'Sample images by style' });
    const items = within(grid).getAllByRole('listitem');
    expect(items).toHaveLength(SAMPLE_IMAGES.length);
    for (const sample of SAMPLE_IMAGES) {
      const image = within(grid).getByAltText(sample.alt);
      expect(image.getAttribute('src')).toBe(sample.src);
      expect(within(grid).getByText(sample.prompt)).toBeTruthy();
    }
    expect(within(grid).getByText('Watercolour')).toBeTruthy();
  });

  it('explains how it works in three steps and that it is free with a daily allowance', async () => {
    render(await HomePage());

    const how = screen.getByRole('heading', { name: 'How it works' }).closest('section');
    expect(how).not.toBeNull();
    expect(within(how!).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Free, with a daily allowance' })).toBeTruthy();
  });

  it('sends signed-in users to the generate screen', async () => {
    requestHeaders.current = new Headers({
      [SESSION_HEADERS.sub]: 'user-sub',
      [SESSION_HEADERS.email]: 'user@example.com',
    });

    await expect(HomePage()).rejects.toThrow(RedirectSignal);
    await expect(HomePage()).rejects.toMatchObject({ url: '/generate' });
  });
});
