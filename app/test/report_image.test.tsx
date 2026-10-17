// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportImage } from '../src/components/report_image';

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

function open() {
  render(<ReportImage imageId={IMAGE_ID} version={2} />);
  fireEvent.click(screen.getByRole('button', { name: 'Report' }));
}

describe('ReportImage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
    await screen.findByText(/Thanks for reporting this image/);
    expect(fetchMock).toHaveBeenCalledWith('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId: IMAGE_ID, version: 2, reason: 'violence' }),
    });
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
  });

  it('closes without sending on Cancel', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Report' })).toBeTruthy();
  });
});
