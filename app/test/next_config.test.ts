import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('next.config', () => {
  it('builds a standalone server for the Lambda image', () => {
    expect(nextConfig.output).toBe('standalone');
  });

  // The optimizer's internal fetch has no X-Origin-Verify header, so the proxy rejects it with 403 (#88).
  it('serves images without the Next.js image optimizer', () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });
});
