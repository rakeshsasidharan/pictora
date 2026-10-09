import { describe, expect, it } from 'vitest';
import { CENTS_PER_POINT, DEFAULT_DAILY_POINTS } from '../src/index.js';

describe('points constants', () => {
  it('grants 25 points a day by default', () => {
    expect(DEFAULT_DAILY_POINTS).toBe(25);
  });

  it('values one point at one cent', () => {
    expect(CENTS_PER_POINT).toBe(1);
  });
});
