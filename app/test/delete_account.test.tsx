// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountDetails } from '../src/components/account_details';
import { DeleteAccount } from '../src/components/delete_account';
import type { MeBody } from '../src/lib/jobs';

function openDialog(onDeleted = vi.fn()) {
  render(<DeleteAccount onDeleted={onDeleted} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
  return {
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
    expect(screen.queryByRole('dialog')).toBeNull();
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

  it('cancels without deleting and clears what was typed', () => {
    const { input } = openDialog();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });
});

describe('AccountDetails', () => {
  afterEach(cleanup);

  it('shows the email, sign-in method, member-since date and today’s points', () => {
    const me: MeBody = {
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
    render(<AccountDetails me={me} method="Google" />);
    expect(screen.getByText('user@example.com')).toBeTruthy();
    expect(screen.getByText('Google')).toBeTruthy();
    expect(screen.getByText('3 September 2026')).toBeTruthy();
    expect(screen.getByText(/18 of 25 left \(7 used\)/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Delete account' })).toBeTruthy();
  });
});
