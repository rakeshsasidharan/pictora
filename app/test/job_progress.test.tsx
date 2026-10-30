// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobProgress } from '../src/components/job_progress';
import type { JobStatusBody } from '../src/lib/jobs';
import type { JobPoll } from '../src/lib/use_job_status';

vi.mock('../src/lib/first_image', () => ({ reportFirstImage: vi.fn() }));

const JOB: JobStatusBody = {
  jobId: '01JBBBBBBBBBBBBBBBBBBBBBBB',
  type: 'generate',
  status: 'queued',
  modelId: 'mock',
  createdAt: '2026-10-30T09:00:00.000Z',
  pointsReserved: 2,
};

const IMAGES = [1, 2].map((version) => ({
  imageId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
  version,
  url: `https://signed.example/v${version}.png`,
  downloadUrl: `https://signed.example/v${version}.png?download`,
}));

const poll = (job?: Partial<JobStatusBody>): JobPoll => ({
  job: job ? { ...JOB, ...job } : undefined,
  timedOut: false,
  lost: false,
});

function progress(job: JobPoll) {
  return (
    <JobProgress
      poll={job}
      pointsReserved={2}
      prompt={`  A lighthouse at dusk ${'with gulls '.repeat(20)}`}
      modelName="Mock"
      count={2}
    />
  );
}

/** The polite live region a screen reader reads each change from (#30). */
const announcement = () => document.querySelector<HTMLElement>('[data-slot="job-announcement"]')!;

describe('JobProgress', () => {
  afterEach(cleanup);

  it('announces each status change in one polite live region (#30)', () => {
    const { rerender } = render(progress(poll()));
    expect(announcement().getAttribute('role')).toBe('status');
    expect(announcement().className).toContain('sr-only');
    expect(announcement().textContent).toBe('Queued…');

    rerender(progress(poll({ status: 'running' })));
    expect(announcement().textContent).toBe('Generating…');
    rerender(progress(poll({ status: 'succeeded', pointsCharged: 2, images: IMAGES })));
    expect(announcement().textContent).toBe('2 images ready');
    // One live region: the visible status line isn't announced as well.
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('announces a failure with the points returned', () => {
    render(
      progress(
        poll({ status: 'failed', pointsCharged: 0, error: 'The model ran into a problem.' }),
      ),
    );
    expect(announcement().textContent).toBe('The model ran into a problem. 2 points returned.');
  });

  it('uses the trimmed prompt as the alt text of every result', () => {
    render(progress(poll({ status: 'succeeded', pointsCharged: 2, images: IMAGES })));
    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(2);
    for (const image of images) {
      const alt = image.getAttribute('alt')!;
      expect(alt.startsWith('A lighthouse at dusk with gulls')).toBe(true);
      expect(alt).toHaveLength(150);
      expect(alt.endsWith('…')).toBe(true);
    }
  });

  it('returns the focus to the result after the full-size view closes', async () => {
    render(progress(poll({ status: 'succeeded', pointsCharged: 2, images: IMAGES })));
    const view = screen.getByRole('button', { name: 'View image 2 full size' });
    view.focus();
    fireEvent.click(view);
    const dialog = screen.getByRole('dialog', { name: 'Full-size image' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(view));
  });
});
