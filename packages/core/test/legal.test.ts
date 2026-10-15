import { describe, expect, it } from 'vitest';
import { TOS_VERSION } from '../src/index.js';

describe('TOS_VERSION', () => {
  it('is a date, so a newer version sorts after an older one', () => {
    expect(TOS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(TOS_VERSION))).toBe(false);
  });
});
