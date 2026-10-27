// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REPORT_REASON_LABELS,
  REPORT_SENT_MESSAGE,
  ReportImage,
} from '../src/components/report_image';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

/** Opens the report dialog and returns it. */
function open(): HTMLElement {
  render(<ReportImage imageId={IMAGE_ID} version={2} />);
  fireEvent.click(screen.getByRole('button', { name: 'Report' }));
  return screen.getByRole('dialog', { name: 'Report this image' });
}

describe('ReportImage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    toast.success.mockReset();
  });

  it('opens a dialog with a radio group of every reason, none picked', () => {
    const dialog = open();
    const reasons = within(dialog).getByRole('radiogroup', { name: 'Reason' });
    const radios = within(reasons).getAllByRole('radio');
    expect(
      radios.map((radio) => document.querySelector(`label[for="${radio.id}"]`)?.textContent),
    ).toEqual(Object.values(REPORT_REASON_LABELS));
    expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Self-harm' }));
    expect(
      within(dialog).getByRole('radio', { name: 'Self-harm' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('asks for a reason before sending', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(screen.getByRole('alert').textContent).toBe('Pick a reason for the report.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the image version and reason, then thanks the user', async () => {
    const fetchMock = vi.fn(async () => new Response('{"reportId":"R1"}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Graphic violence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(REPORT_SENT_MESSAGE));
    expect(fetchMock).toHaveBeenCalledWith('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId: IMAGE_ID, version: 2, reason: 'violence' }),
    });
    // The dialog closes, and the same version can't be reported twice.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reported' }).disabled).toBe(true);
  });

  it('shows the error when the report is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Image not found."}', { status: 404 })),
    );
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Something else' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Image not found.'));
    // The dialog stays open to try again.
    expect(screen.getByRole('dialog', { name: 'Report this image' })).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('closes without sending on Cancel, and forgets the reason picked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Something else' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    expect(screen.getByRole('radio', { name: 'Something else' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('closes on Escape', async () => {
    const dialog = open();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
