// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountDetails } from '../src/components/account_details';
import { DeleteAccount } from '../src/components/delete_account';
import type { MeBody } from '../src/lib/jobs';

function openDialog(onDeleted = vi.fn()) {
  render(<DeleteAccount onDeleted={onDeleted} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
  const dialog = screen.getByRole('alertdialog', { name: 'Are you sure?' });
  return {
    dialog,
    onDeleted,
    input: screen.getByRole('textbox', { name: /Type DELETE to confirm/ }),
    confirm: screen.getByRole('button', { name: 'Delete my account' }) as HTMLButtonElement,
  };
}

describe('DeleteAccount', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('summarises what deletion removes', () => {
    render(<DeleteAccount />);
    expect(screen.getByText(/every image you created/)).toBeTruthy();
    expect(screen.getByText(/Job records expire within 30 days/)).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('only deletes once DELETE has been typed exactly', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { input, confirm } = openDialog();
    expect(confirm.disabled).toBe(true);
    for (const value of ['delete', 'DELET', 'DELETE ', ' DELETE']) {
      fireEvent.change(input, { target: { value } });
      expect(confirm.disabled).toBe(true);
    }
    fireEvent.click(confirm);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(confirm.disabled).toBe(false);
  });

  it('sends DELETE /api/me and moves on once deletion has started', async () => {
    const fetchMock = vi.fn(async () => new Response('{"status":"deleting"}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const { input, confirm, onDeleted } = openDialog();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/me', { method: 'DELETE' });
  });

  it('shows the error when deletion could not start', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Nothing was deleted.', code: 'deletion_failed' }), {
            status: 503,
          }),
      ),
    );
    const { input, confirm, onDeleted } = openDialog();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    fireEvent.click(confirm);
    expect((await screen.findByRole('alert')).textContent).toBe('Nothing was deleted.');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('keeps the dialog open while deleting, then shows the error inside it', async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    const { dialog, input, confirm } = openDialog();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    fireEvent.click(confirm);
    expect(await within(dialog).findByRole('button', { name: 'Deleting…' })).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    answer(new Response(JSON.stringify({ error: 'Nothing was deleted.' }), { status: 503 }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Nothing was deleted.');
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });

  it('cancels without deleting and clears what was typed', () => {
    const { input } = openDialog();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });
});

const ME: MeBody = {
  sub: 's',
  email: 'user@example.com',
  status: 'active',
  date: '2026-10-15',
  dailyLimit: 25,
  pointsUsed: 7,
  pointsLeft: 18,
  activeJobs: 0,
  onboardingRequired: false,
  memberSince: '2026-09-03T10:00:00.000Z',
};

describe('AccountDetails', () => {
  afterEach(cleanup);

  it('shows the email, sign-in method, member-since date and today’s points', () => {
    render(<AccountDetails me={ME} method="Google" />);
    expect(screen.getByText('user@example.com')).toBeTruthy();
    expect(screen.getByText('Google')).toBeTruthy();
    expect(screen.getByText('3 September 2026')).toBeTruthy();
    expect(screen.getByText(/18 of 25 left \(7 used\)/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Delete account' })).toBeTruthy();
  });

  it('has a Legal and support card with the legal pages and the contact email (#161)', () => {
    render(<AccountDetails me={ME} method="Email and password" />);
    const card = screen
      .getByRole('heading', { name: 'Legal and support' })
      .closest('[data-slot="legal-support"]') as HTMLElement;
    expect(card.getAttribute('data-slot')).toBe('legal-support');
    const legal = within(card).getByRole('navigation', { name: 'Legal' });
    expect(
      within(legal)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Terms of serviceThe rules for using Pictora', '/terms'],
      ['Content policyWhat you can and can’t create', '/content-policy'],
      ['Privacy policyWhat we keep about you, and why', '/privacy'],
    ]);
    const contact = within(card).getByRole('link', {
      name: /^Questions, feedback or a problem to report\s*contact@rpillai\.dev$/,
    });
    expect(contact.getAttribute('href')).toBe('mailto:contact@rpillai.dev');
    // Its name is its visible text, which axe's label-content-name-mismatch requires.
    expect(contact.hasAttribute('aria-label')).toBe(false);
    expect(within(contact).getByText('contact@rpillai.dev')).toBeTruthy();
    // It sits between the profile and account deletion, and the page has no site footer.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Profile', 'Legal and support', 'Delete account']);
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });
});
