import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppShell, type AppShellProps } from '../src/components/app_shell';
import { SESSION_HEADERS } from '../src/lib/session';

const request = vi.hoisted(() => ({ headers: new Headers(), cookies: new Map<string, string>() }));

vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: (name: string) =>
      request.cookies.has(name) ? { name, value: request.cookies.get(name) } : undefined,
  }),
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect to ${url}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  usePathname: () => '/',
}));

const { default: AppLayout } = await import('../src/app/(app)/layout');
const { default: SiteLayout } = await import('../src/app/(site)/layout');

function signIn(groups = '') {
  request.headers = new Headers({
    [SESSION_HEADERS.sub]: 'user-sub',
    [SESSION_HEADERS.email]: 'user@example.com',
    [SESSION_HEADERS.groups]: groups,
  });
}

async function shellProps(): Promise<AppShellProps> {
  const element = await AppLayout({ children: <p>Page</p> });
  expect(isValidElement(element) && element.type).toBe(AppShell);
  return (element as ReactElement<AppShellProps>).props;
}

describe('(app) layout', () => {
  it('wraps signed-in pages in the sidebar shell, with the Admin link for admins only', async () => {
    signIn();
    request.cookies.clear();
    const props = await shellProps();
    expect(props).toMatchObject({ email: 'user@example.com', admin: false });
    expect(renderToStaticMarkup(props.children)).toBe('<p>Page</p>');
    // The legal links stay under each page.
    expect(renderToStaticMarkup(props.footer)).toContain('href="/terms"');

    signIn('admins');
    expect((await shellProps()).admin).toBe(true);
  });

  it('starts the sidebar collapsed when the user has not chosen yet', async () => {
    signIn();
    request.cookies.clear();
    expect((await shellProps()).defaultOpen).toBe(false);
  });

  it('opens the sidebar as the user left it', async () => {
    signIn();
    request.cookies.set('sidebar_state', 'false');
    expect((await shellProps()).defaultOpen).toBe(false);
    request.cookies.set('sidebar_state', 'true');
    expect((await shellProps()).defaultOpen).toBe(true);
    // Anything else is no choice at all.
    request.cookies.set('sidebar_state', '');
    expect((await shellProps()).defaultOpen).toBe(false);
  });

  it('sends a visitor without a session home', async () => {
    request.headers = new Headers();
    await expect(AppLayout({ children: null })).rejects.toMatchObject({ url: '/' });
  });
});

describe('(site) layout', () => {
  it('keeps the site header and footer on public pages', async () => {
    request.headers = new Headers();
    const html = renderToStaticMarkup(await SiteLayout({ children: <main>Terms</main> }));
    expect(html).toMatch(/^<header class="site-header">.*<main>Terms<\/main><footer/);
    expect(html).toContain('href="/auth/login"');

    signIn();
    expect(renderToStaticMarkup(await SiteLayout({ children: null }))).toContain(
      'user@example.com',
    );
  });
});
