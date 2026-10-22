import { describe, expect, it } from 'vitest';
import {
  URL_REFRESH_AFTER_MS,
  createdText,
  placeholderText,
  urlsMayHaveExpired,
  versionFields,
} from '../src/lib/gallery_format';
import type { ActiveJobBody, ImageVersionBody } from '../src/lib/images';

const base: ImageVersionBody = {
  version: 1,
  width: 1536,
  height: 1024,
  url: 'u',
  downloadUrl: 'd',
  thumbUrl: 't',
};

describe('versionFields', () => {
  it('lists how a generated version was made, then its settings', () => {
    expect(
      versionFields(
        {
          ...base,
          prompt: 'A fox',
          enhancedPrompt: 'A red fox in snow',
          avoid: 'text',
          modelId: 'mock',
          style: 'anime',
          aspect: '3:2',
          quality: 'high',
          transparentBackground: true,
          seed: 0,
          createdAt: '2026-01-05T08:05:00.000Z',
        },
        { mock: 'Mock (dev only)' },
      ),
    ).toEqual([
      { label: 'Prompt', value: 'A fox' },
      { label: 'Enhanced prompt', value: 'A red fox in snow' },
      { label: 'Avoid', value: 'text' },
      { label: 'Model', value: 'Mock (dev only)' },
      { label: 'Style', value: 'Anime' },
      { label: 'Size', value: '1536 × 1024 (3:2)' },
      { label: 'Quality', value: 'High' },
      { label: 'Background', value: 'Transparent' },
      { label: 'Seed', value: '0' },
      { label: 'Created', value: '5 January 2026 at 08:05 UTC' },
    ]);
  });

  it('shows an edit by its instruction, and a model missing from the registry by its ID', () => {
    expect(
      versionFields(
        { ...base, version: 3, parentVersion: 1, editInstruction: 'Add snow', modelId: 'old' },
        {},
      ),
    ).toEqual([
      { label: 'Edit', value: 'Add snow' },
      { label: 'Edited from', value: 'Version 1' },
      { label: 'Model', value: 'old' },
      { label: 'Size', value: '1536 × 1024' },
    ]);
  });

  it('leaves out the style when there was none, and marks uploads', () => {
    expect(versionFields({ ...base, source: 'upload', style: 'none' }, {})).toEqual([
      { label: 'Source', value: 'Uploaded image' },
      { label: 'Size', value: '1536 × 1024' },
    ]);
  });
});

describe('createdText', () => {
  it('keeps a value that is not a date as it is', () => {
    expect(createdText('yesterday')).toBe('yesterday');
  });
});

describe('placeholderText', () => {
  const job: ActiveJobBody = {
    jobId: 'J',
    type: 'generate',
    status: 'queued',
    createdAt: '2026-10-15T12:00:00.000Z',
    text: 'A fox',
    count: 1,
  };

  it('says what the job is doing', () => {
    expect(placeholderText(job)).toBe('Queued · 1 image');
    expect(placeholderText({ ...job, status: 'running', count: 3 })).toBe('Generating · 3 images');
    expect(placeholderText({ ...job, type: 'edit', status: 'running' })).toBe('Editing');
    expect(placeholderText({ ...job, type: 'edit' })).toBe('Queued');
  });
});

describe('urlsMayHaveExpired', () => {
  it('is true only once the refresh window has passed', () => {
    expect(urlsMayHaveExpired(1_000, 1_000 + URL_REFRESH_AFTER_MS - 1)).toBe(false);
    expect(urlsMayHaveExpired(1_000, 1_000 + URL_REFRESH_AFTER_MS)).toBe(true);
  });
});
