// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEADERS } from '../src/lib/session';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));

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

const { default: AdminLayout } = await import('../src/app/admin/layout');

function signIn(groups: string) {
  requestHeaders.current = new Headers({
    [SESSION_HEADERS.sub]: 'user-sub',
    [SESSION_HEADERS.email]: 'user@example.com',
    [SESSION_HEADERS.groups]: groups,
  });
}

describe('admin layout', () => {
  afterEach(cleanup);

  it('shows the admin navigation and the page to admins', async () => {
    signIn('admins');
    render(await AdminLayout({ children: <p>Dashboard body</p> }));
    expect(screen.getByRole('navigation', { name: 'Admin' })).toBeTruthy();
    expect(screen.getByText('Dashboard body')).toBeTruthy();
  });

  it('never renders the page for anyone else', async () => {
    signIn('testers');
    render(await AdminLayout({ children: <p>Dashboard body</p> }));
    expect(screen.getByRole('heading', { name: 'Forbidden' })).toBeTruthy();
    expect(screen.queryByText('Dashboard body')).toBeNull();
    requestHeaders.current = new Headers();
    await expect(AdminLayout({ children: null })).rejects.toMatchObject({ url: '/' });
  });
});
