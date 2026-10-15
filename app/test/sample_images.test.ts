import { statSync } from 'node:fs';
import { join } from 'node:path';
import { STYLE_PRESETS } from '@pictora/core';
import { describe, expect, it } from 'vitest';
import { SAMPLE_IMAGES } from '../src/lib/sample_images';

describe('sample image manifest', () => {
  it('has one sample per style preset, in picker order', () => {
    expect(SAMPLE_IMAGES.map((sample) => sample.style)).toEqual(
      STYLE_PRESETS.filter((preset) => preset.id !== 'none').map((preset) => preset.id),
    );
  });

  it.each(SAMPLE_IMAGES.map((sample) => [sample.style, sample.src] as const))(
    '%s points to a small file in public/static',
    (_style, src) => {
      const file = statSync(join(process.cwd(), 'public', src));
      expect(file.isFile()).toBe(true);
      expect(file.size).toBeLessThan(100 * 1024);
    },
  );

  it('gives every sample a prompt and alt text', () => {
    for (const sample of SAMPLE_IMAGES) {
      expect(sample.prompt.trim()).not.toBe('');
      expect(sample.alt.trim()).not.toBe('');
    }
  });
});
