// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollBehavior } from '../src/lib/motion';

function prefersReducedMotion(reduce: boolean | undefined) {
  vi.stubGlobal(
    'matchMedia',
    reduce === undefined
      ? undefined
      : vi.fn((query: string) => ({
          matches: reduce && query === '(prefers-reduced-motion: reduce)',
        })),
  );
  window.matchMedia = globalThis.matchMedia;
}

describe('scrollBehavior', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scrolls smoothly by default', () => {
    prefersReducedMotion(false);
    expect(scrollBehavior()).toBe('smooth');
  });

  it('jumps when the user prefers reduced motion (#30)', () => {
    prefersReducedMotion(true);
    expect(scrollBehavior()).toBe('auto');
  });

  it('scrolls smoothly where matchMedia is missing', () => {
    prefersReducedMotion(undefined);
    expect(scrollBehavior()).toBe('smooth');
  });
});
