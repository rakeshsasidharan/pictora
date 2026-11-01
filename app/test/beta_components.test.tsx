// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BETA_FEEDBACK_HREF, BetaBanner, BetaRejectedNotice } from '../src/components/beta_banner';
import { BetaAllowlist } from '../src/components/beta_allowlist';
import type { BetaAllowlistBody } from '../src/lib/beta';

const toasts = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(toasts.message, { error: toasts.error }) }));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LIST: BetaAllowlistBody = {
  betaMode: true,
  entries: [
    { email: 'zed@example.com', addedAt: '2026-10-30T08:00:00.000Z', addedBy: 'admin-sub' },
    { email: 'ana@example.com', addedAt: '', addedBy: '' },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('BetaBanner', () => {
  it('says Pictora is in private beta and links to feedback by email', () => {
    render(<BetaBanner />);
    const banner = screen.getByRole('note', { name: 'Private beta' });
    within(banner).getByText('Pictora is in private beta');
    const link = within(banner).getByRole('link', { name: 'send feedback' });
    expect(link.getAttribute('href')).toBe(BETA_FEEDBACK_HREF);
    expect(BETA_FEEDBACK_HREF).toBe('mailto:contact@rpillai.dev?subject=Pictora%20beta%20feedback');
  });
});

describe('BetaRejectedNotice', () => {
  it('tells a refused visitor the beta is invite only, as an alert, with the contact email', () => {
    render(<BetaRejectedNotice />);
    const alert = screen.getByRole('alert');
    within(alert).getByText('Pictora is in private beta');
    within(alert).getByText(/by invitation only/);
    expect(within(alert).getByRole('link').getAttribute('href')).toBe('mailto:contact@rpillai.dev');
  });
});

describe('BetaAllowlist', () => {
  it('lists the allowlist in email order and shows whether beta mode is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    render(<BetaAllowlist />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual([
      'ana@example.com',
      'zed@example.com',
    ]);
    within(rows[1] as HTMLElement).getByText('2026-10-30');
    screen.getByText('Beta mode on');
    screen.getByText('2 emails');
  });

  it('says when the list is empty and beta mode is off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ betaMode: false, entries: [] })),
    );
    render(<BetaAllowlist />);
    await screen.findByText('No emails on the allowlist yet.');
    screen.getByText('Beta mode off');
  });

  it('shows why the list could not load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'Only admins can do this.' }, 403)),
    );
    render(<BetaAllowlist />);
    expect((await screen.findByRole('alert')).textContent).toBe('Only admins can do this.');
  });

  it('adds an email and shows it in the list', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? json({ email: 'new@example.com', addedAt: '2026-10-31T09:00:00.000Z', addedBy: 'a' })
        : json(LIST),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<BetaAllowlist />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' New@Example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('new@example.com');
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/admin/beta/allowlist');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ email: 'New@Example.com' });
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('');
    expect(toasts.message).toHaveBeenCalledWith('Added new@example.com');
  });

  it('shows the server’s answer to an invalid email, and asks for one when empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? json({ error: 'Enter a valid email address of at most 254 characters.' }, 400)
          : json(LIST),
      ),
    );
    render(<BetaAllowlist />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Enter an email address.');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/valid email address/),
    );
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
  });

  it('removes an email', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? json({ email: 'ana@example.com', removed: true }) : json(LIST),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<BetaAllowlist />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Remove ana@example.com' }));
    await waitFor(() => expect(screen.queryByText('ana@example.com')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/beta/allowlist/ana%40example.com', {
      method: 'DELETE',
    });
    expect(toasts.message).toHaveBeenCalledWith('Removed ana@example.com');
  });

  it('keeps an email whose removal failed, and says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'DELETE' ? json({ error: 'Server error' }, 500) : json(LIST),
      ),
    );
    render(<BetaAllowlist />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Remove ana@example.com' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Server error'));
    screen.getByText('ana@example.com');
  });
});
