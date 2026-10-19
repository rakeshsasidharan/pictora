// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEADERS } from '../src/lib/session';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
const onboarded = vi.hoisted(() => ({ current: true }));

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

const { default: EditPage } = await import('../src/app/edit/page');

describe('edit page', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers({
      [SESSION_HEADERS.sub]: 'user-sub',
      [SESSION_HEADERS.email]: 'user@example.com',
    });
    onboarded.current = true;
  });
  afterEach(cleanup);

  it('offers an upload to start from', async () => {
    render(await EditPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Edit an image' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload image' })).toBeTruthy();
  });

  it('sends signed-out visitors home and new users to onboarding', async () => {
    requestHeaders.current = new Headers();
    await expect(EditPage()).rejects.toMatchObject({ url: '/' });
    requestHeaders.current = new Headers({
      [SESSION_HEADERS.sub]: 'user-sub',
      [SESSION_HEADERS.email]: 'user@example.com',
    });
    onboarded.current = false;
    await expect(EditPage()).rejects.toMatchObject({ url: '/onboarding' });
  });
});
