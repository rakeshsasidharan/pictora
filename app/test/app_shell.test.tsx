// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell, isActivePath } from '../src/components/app_shell';
import { notifyImagesChanged } from '../src/lib/images_changed';
import type { GalleryImageBody } from '../src/lib/images';

const location = vi.hoisted(() => ({ pathname: '/generate' }));

vi.mock('next/navigation', () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));

/** A ULID-shaped image ID that sorts by `n`. */
const idOf = (n: number) => `01J${String(n).padStart(23, '0')}`;

function image(n: number): GalleryImageBody {
  return {
    imageId: idOf(n),
    title: `Image ${n}`,
    latestVersion: 1,
    versionCount: 1,
    createdAt: new Date(Date.now() - n * 60 * 60 * 1000).toISOString(),
    thumbUrl: `https://signed.example/${n}_thumb.webp`,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ME = { pointsLeft: 18, dailyLimit: 25 };

/** A fetch stand-in: each URL answers the next response queued for it, repeating the last one. */
function stubFetch(routes: Record<string, (Response | (() => Promise<Response>))[]>) {
  const fetchMock = vi.fn(async (url: string) => {
    const queue = routes[url];
    if (!queue || queue.length === 0) throw new Error(`Unexpected fetch ${url}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return typeof next === 'function' ? next() : next.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const HISTORY_URL = '/api/images?limit=10';

function setMobile(mobile: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: mobile,
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  window.matchMedia = globalThis.matchMedia;
}

function renderShell({ admin = false, defaultOpen = true } = {}) {
  return render(
    <AppShell email="user@example.com" admin={admin} defaultOpen={defaultOpen}>
      <p>Page content</p>
    </AppShell>,
  );
}

const pages = () => screen.getByRole('navigation', { name: 'Pages' });
const sidebar = () => document.querySelector('[data-slot="sidebar"]')!;
// The rail at the sidebar's edge has the same name, but isn't in the tab order.
const trigger = () =>
  screen
    .getAllByRole('button', { name: 'Toggle Sidebar' })
    .find((button) => button.getAttribute('data-slot') === 'sidebar-trigger')!;

describe('AppShell', () => {
  beforeEach(() => {
    location.pathname = '/generate';
    setMobile(false);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    document.cookie = 'sidebar_state=; max-age=0; path=/';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe('links', () => {
    it('links to each page and highlights the current one', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      location.pathname = '/gallery/01JAAAAAAAAAAAAAAAAAAAAAAA';
      renderShell();

      const links = within(pages()).getAllByRole('link');
      expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
        ['Generate', '/generate'],
        ['Gallery', '/gallery'],
        ['Edit', '/edit'],
      ]);
      const gallery = within(pages()).getByRole('link', { name: 'Gallery' });
      expect(gallery.getAttribute('aria-current')).toBe('page');
      expect(gallery.getAttribute('data-active')).toBe('true');
      expect(
        within(pages()).getByRole('link', { name: 'Generate' }).getAttribute('aria-current'),
      ).toBeNull();
      expect(screen.getByText('Page content')).toBeTruthy();
      await screen.findByText('No images yet');
    });

    it('shows the Admin link to admins only', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell();
      expect(within(pages()).queryByRole('link', { name: 'Admin' })).toBeNull();
      cleanup();

      location.pathname = '/admin/users';
      renderShell({ admin: true });
      const admin = within(pages()).getByRole('link', { name: 'Admin' });
      expect(admin.getAttribute('href')).toBe('/admin');
      expect(admin.getAttribute('aria-current')).toBe('page');
      await screen.findByText('No images yet');
    });

    it('has no New image button: the Generate link opens the generate screen', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell();
      expect(screen.queryByRole('link', { name: 'New image' })).toBeNull();
      expect(screen.queryByText('New image')).toBeNull();
      const header = document.querySelector('[data-slot="sidebar-header"]') as HTMLElement;
      // The header holds only the Pictora home link.
      expect(
        within(header)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Pictora']);
      const generate = within(pages()).getByRole('link', { name: 'Generate' });
      expect(generate.getAttribute('href')).toBe('/generate');
      expect(generate.getAttribute('aria-current')).toBe('page');
      await screen.findByText('No images yet');
    });
  });

  describe('collapse', () => {
    it('collapses to icons with the trigger and remembers it in a cookie', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell();
      expect(sidebar().getAttribute('data-state')).toBe('expanded');

      fireEvent.click(trigger());
      expect(sidebar().getAttribute('data-state')).toBe('collapsed');
      expect(sidebar().getAttribute('data-collapsible')).toBe('icon');
      expect(document.cookie).toContain('sidebar_state=false');

      fireEvent.click(trigger());
      expect(sidebar().getAttribute('data-state')).toBe('expanded');
      await screen.findByText('No images yet');
    });

    it('toggles with Ctrl+B and Cmd+B', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell();
      fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
      expect(sidebar().getAttribute('data-state')).toBe('collapsed');
      fireEvent.keyDown(window, { key: 'b', metaKey: true });
      expect(sidebar().getAttribute('data-state')).toBe('expanded');
      // B alone is just typing.
      fireEvent.keyDown(window, { key: 'b' });
      expect(sidebar().getAttribute('data-state')).toBe('expanded');
      await screen.findByText('No images yet');
    });

    it('starts collapsed when the user left it collapsed', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell({ defaultOpen: false });
      expect(sidebar().getAttribute('data-state')).toBe('collapsed');
      await screen.findByText('No images yet');
    });

    it('opens as a sheet on mobile, which closes when a link is chosen', async () => {
      setMobile(true);
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell();
      expect(screen.queryByRole('dialog')).toBeNull();

      fireEvent.click(trigger());
      const sheet = screen.getByRole('dialog', { name: 'Sidebar' });
      await within(sheet).findByText('No images yet');
      fireEvent.click(within(sheet).getByRole('link', { name: 'Gallery' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });

  describe('history', () => {
    it('shows a loading state, then the 10 newest images linking to their pages', async () => {
      let answer: (response: Response) => void = () => undefined;
      const twelve = Array.from({ length: 12 }, (_, index) => image(index + 1));
      stubFetch({
        [HISTORY_URL]: [() => new Promise<Response>((resolve) => (answer = resolve))],
        '/api/me': [json(ME)],
      });
      renderShell();
      expect(screen.getByRole('list', { name: 'Loading history' })).toBeTruthy();

      await act(async () => answer(json({ images: twelve })));
      const history = await screen.findByRole('navigation', { name: 'History' });
      const links = within(history).getAllByRole('link');
      expect(links).toHaveLength(10);
      expect(links.map((link) => link.textContent)).toEqual([
        'Image 11 hour ago',
        'Image 22 hours ago',
        'Image 33 hours ago',
        'Image 44 hours ago',
        'Image 55 hours ago',
        'Image 66 hours ago',
        'Image 77 hours ago',
        'Image 88 hours ago',
        'Image 99 hours ago',
        'Image 1010 hours ago',
      ]);
      expect(links[0]!.getAttribute('href')).toBe(`/gallery/${idOf(1)}`);
      expect(links[0]!.querySelector('img')!.getAttribute('src')).toBe(
        'https://signed.example/1_thumb.webp',
      );
      expect(screen.queryByRole('list', { name: 'Loading history' })).toBeNull();
    });

    it('highlights the image whose page is open', async () => {
      location.pathname = `/gallery/${idOf(2)}`;
      stubFetch({ [HISTORY_URL]: [json({ images: [image(1), image(2)] })], '/api/me': [json(ME)] });
      renderShell();
      const history = await screen.findByRole('navigation', { name: 'History' });
      const [first, second] = within(history).getAllByRole('link');
      expect(first!.getAttribute('data-active')).toBe('false');
      expect(second!.getAttribute('data-active')).toBe('true');
    });

    it('says when there are no images yet', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [], jobs: [] })], '/api/me': [json(ME)] });
      renderShell();
      expect(await screen.findByText('No images yet')).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'History' })).toBeNull();
    });

    it('shows an error with a retry', async () => {
      const fetchMock = stubFetch({
        [HISTORY_URL]: [json({ error: 'Boom' }, 500), json({ images: [image(1)] })],
        '/api/me': [json(ME)],
      });
      renderShell();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain("We couldn't load your history.");

      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      const history = await screen.findByRole('navigation', { name: 'History' });
      expect(within(history).getByText('Image 1')).toBeTruthy();
      expect(fetchMock.mock.calls.filter(([url]) => url === HISTORY_URL)).toHaveLength(2);
    });

    it('refreshes when a job finishes', async () => {
      stubFetch({
        [HISTORY_URL]: [json({ images: [image(2)] }), json({ images: [image(1), image(2)] })],
        '/api/me': [json(ME)],
      });
      renderShell();
      const history = await screen.findByRole('navigation', { name: 'History' });
      expect(within(history).getAllByRole('link')).toHaveLength(1);

      act(() => notifyImagesChanged());
      await waitFor(() => expect(within(history).getAllByRole('link')).toHaveLength(2));
      expect(within(history).getAllByRole('link')[0]!.textContent).toContain('Image 1');
    });

    it('keeps the list showing when a refresh fails', async () => {
      stubFetch({
        [HISTORY_URL]: [json({ images: [image(1)] }), json({ error: 'Boom' }, 500)],
        '/api/me': [json(ME)],
      });
      const fetchMock = vi.mocked(fetch);
      renderShell();
      const history = await screen.findByRole('navigation', { name: 'History' });
      act(() => notifyImagesChanged());
      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([url]) => url === HISTORY_URL)).toHaveLength(2),
      );
      expect(within(history).getByText('Image 1')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('footer', () => {
    it("shows today's points and refreshes them when a job finishes", async () => {
      stubFetch({
        [HISTORY_URL]: [json({ images: [] })],
        '/api/me': [json(ME), json({ pointsLeft: 15, dailyLimit: 25 })],
      });
      renderShell();
      expect(screen.getByLabelText('Loading points')).toBeTruthy();
      expect(await screen.findByText('18 of 25 points left today')).toBeTruthy();

      act(() => notifyImagesChanged());
      expect(await screen.findByText('15 of 25 points left today')).toBeTruthy();
    });

    it('says when the points could not be read', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json({}, 500)] });
      renderShell();
      expect(await screen.findByText('Points unavailable')).toBeTruthy();
    });

    it('has a user menu with the email, the account page and sign-out', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      const { container } = renderShell();
      await screen.findByText('18 of 25 points left today');
      const form = container.querySelector('form')!;
      expect(form.getAttribute('action')).toBe('/auth/logout');
      expect(form.getAttribute('method')).toBe('post');
      const submit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => undefined);

      // Radix opens the menu on pointer down, or Enter from the keyboard.
      fireEvent.keyDown(screen.getByRole('button', { name: 'user@example.com' }), { key: 'Enter' });
      const menu = screen.getByRole('menu');
      expect(within(menu).getByText('user@example.com')).toBeTruthy();
      expect(within(menu).getByRole('menuitem', { name: 'Account' }).getAttribute('href')).toBe(
        '/account',
      );
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
      expect(submit).toHaveBeenCalledOnce();
    });

    it('keeps Account in the user menu only, not in the page links', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell();
      expect(within(sidebar() as HTMLElement).queryByRole('link', { name: 'Account' })).toBeNull();
      await screen.findByText('No images yet');
    });

    it('ends the sidebar footer with the user menu', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell();
      await screen.findByText('18 of 25 points left today');
      const footer = document.querySelector<HTMLElement>('[data-slot="sidebar-footer"]')!;
      const items = footer.querySelectorAll('[data-slot="sidebar-menu-item"]');
      expect(within(items[items.length - 1] as HTMLElement).getByRole('button')).toBe(
        screen.getByRole('button', { name: 'user@example.com' }),
      );
      expect(within(footer).queryByRole('button', { name: 'Theme' })).toBeNull();
    });

    it('puts the theme switcher at the right edge of the page header', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell();
      const header = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"] > header')!;
      const theme = within(header).getByRole('button', { name: 'Theme' });
      // The last thing in the header, pushed to the edge.
      expect(header.lastElementChild?.contains(theme)).toBe(true);
      expect(header.lastElementChild?.className).toContain('ml-auto');
      expect(within(sidebar() as HTMLElement).queryByRole('button', { name: 'Theme' })).toBeNull();
      await screen.findByText('No images yet');
    });
  });

  describe('logo', () => {
    it('shows the Pictora app icon in the sidebar and the mobile header', async () => {
      stubFetch({ [HISTORY_URL]: [json({ images: [] })], '/api/me': [json(ME)] });
      renderShell();
      const sidebarLogo = document.querySelector<HTMLImageElement>(
        '[data-slot="sidebar-header"] img',
      );
      expect(sidebarLogo?.getAttribute('src')).toBe('/icons/icon_192.png');
      expect(sidebarLogo?.getAttribute('alt')).toBe('');
      const headerLogo = document.querySelector<HTMLImageElement>(
        '[data-slot="sidebar-inset"] > header img',
      );
      expect(headerLogo?.getAttribute('src')).toBe('/icons/icon_192.png');
      // The letter placeholder is gone; the link is named by the text beside the icon.
      expect(screen.getAllByRole('link', { name: 'Pictora' }).length).toBeGreaterThan(0);
      await screen.findByText('No images yet');
    });
  });
});

describe('isActivePath', () => {
  it('matches the page and the pages under it only', () => {
    expect(isActivePath('/gallery', '/gallery')).toBe(true);
    expect(isActivePath('/gallery/01J', '/gallery')).toBe(true);
    expect(isActivePath('/galleryx', '/gallery')).toBe(false);
    expect(isActivePath('/generate', '/gallery')).toBe(false);
  });
});
