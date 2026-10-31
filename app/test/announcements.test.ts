import { describe, expect, it } from 'vitest';
import { jobAnnouncement } from '../src/lib/announcements';

describe('jobAnnouncement', () => {
  it('says what the job is doing while it runs', () => {
    expect(jobAnnouncement({ status: 'queued' })).toBe('Queued…');
    expect(jobAnnouncement({ status: 'running' })).toBe('Generating…');
    expect(jobAnnouncement({ status: 'scheduled' })).toBe(
      'Scheduled. Your images will be in your gallery within 24 hours.',
    );
    expect(jobAnnouncement({ status: 'submitted' })).toBe(jobAnnouncement({ status: 'scheduled' }));
  });

  it('counts the images that are ready, or says what the caller gives', () => {
    expect(jobAnnouncement({ status: 'succeeded', images: 2 })).toBe('2 images ready');
    expect(jobAnnouncement({ status: 'succeeded', images: 1 })).toBe('1 image ready');
    expect(jobAnnouncement({ status: 'succeeded' })).toBe('1 image ready');
    expect(jobAnnouncement({ status: 'succeeded', readyText: 'Your edit is ready.' })).toBe(
      'Your edit is ready.',
    );
  });

  it('says why a job failed and the points returned', () => {
    expect(
      jobAnnouncement({ status: 'failed', error: 'The model ran into a problem.', refunded: 2 }),
    ).toBe('The model ran into a problem. 2 points returned.');
    expect(jobAnnouncement({ status: 'blocked', error: 'This prompt was blocked.' })).toBe(
      'This prompt was blocked.',
    );
    expect(jobAnnouncement({ status: 'failed' })).toBe('Something went wrong.');
  });
});
