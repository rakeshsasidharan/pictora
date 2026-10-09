import { describe, expect, it } from 'vitest';
import {
  ASPECTS,
  CENTS_PER_POINT,
  DEFAULT_DAILY_POINTS,
  QUALITIES,
  estimatePoints,
  loadSeedRegistry,
  pointsForCents,
  refundPoints,
  settlePoints,
  type ModelConfig,
} from '../src/index.js';

const models = loadSeedRegistry();

function model(id: string): ModelConfig {
  const found = models.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing model ${id}`);
  return found;
}

/** Points per image at each offered quality, from the PRD's model catalogue and "What 25 points buys". */
const EXPECTED_COST_POINTS: Record<string, Partial<Record<(typeof QUALITIES)[number], number>>> = {
  'gpt-image-2': { draft: 1, standard: 6, high: 22 },
  'gpt-image-1-mini': { draft: 1 },
  'gemini-3.1-flash-image': { standard: 7, high: 11 },
  'gemini-3.1-flash-lite-image': { draft: 4 },
  'gemini-3-pro-image': { standard: 14, high: 24 },
  mock: { draft: 1, standard: 2, high: 3 },
};

describe('points constants', () => {
  it('grants 25 points a day by default', () => {
    expect(DEFAULT_DAILY_POINTS).toBe(25);
  });

  it('values one point at one cent', () => {
    expect(CENTS_PER_POINT).toBe(1);
  });
});

describe('estimatePoints', () => {
  it('covers every seed model', () => {
    expect(models.map((entry) => entry.id).sort()).toEqual(
      Object.keys(EXPECTED_COST_POINTS).sort(),
    );
  });

  for (const [id, costs] of Object.entries(EXPECTED_COST_POINTS)) {
    for (const quality of QUALITIES) {
      const cost = costs[quality];
      if (cost === undefined) {
        it(`rejects ${quality} quality on ${id}`, () => {
          expect(() => estimatePoints(model(id), quality, '1:1', 1)).toThrow(
            /does not support quality/,
          );
        });
        continue;
      }
      it(`charges ${cost} points per image for ${id} at ${quality} quality`, () => {
        for (const aspect of ASPECTS) {
          expect(estimatePoints(model(id), quality, aspect, 1)).toBe(cost);
        }
        expect(estimatePoints(model(id), quality, '1:1', 4)).toBe(cost * 4);
      });
    }
  }

  it('matches the images a day in the PRD table for 25 points', () => {
    const imagesPerDay = (id: string, quality: (typeof QUALITIES)[number]) =>
      Math.floor(DEFAULT_DAILY_POINTS / estimatePoints(model(id), quality, '1:1', 1));
    expect(imagesPerDay('gpt-image-1-mini', 'draft')).toBe(25);
    expect(imagesPerDay('gemini-3.1-flash-lite-image', 'draft')).toBe(6);
    expect(imagesPerDay('gemini-3.1-flash-image', 'standard')).toBe(3);
    expect(imagesPerDay('gpt-image-2', 'standard')).toBe(4);
    expect(imagesPerDay('gemini-3-pro-image', 'standard')).toBe(1);
    expect(imagesPerDay('gpt-image-2', 'high')).toBe(1);
  });

  it.each([0, 5, 1.5, -1, Number.NaN])('rejects a count of %s', (count) => {
    expect(() => estimatePoints(model('gpt-image-2'), 'draft', '1:1', count)).toThrow(RangeError);
  });

  it('rejects an aspect the model does not list', () => {
    const squareOnly: ModelConfig = {
      ...model('mock'),
      capabilities: { ...model('mock').capabilities, aspects: ['1:1'] },
    };
    expect(() => estimatePoints(squareOnly, 'draft', '16:9', 1)).toThrow(
      /does not support aspect 16:9/,
    );
  });
});

describe('pointsForCents', () => {
  it.each([
    [0, 0],
    [0.5, 1],
    [5.3, 6],
    [6, 6],
    [21.1, 22],
  ])('turns %s cents into %s points', (cents, points) => {
    expect(pointsForCents(cents)).toBe(points);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s cents', (cents) => {
    expect(() => pointsForCents(cents)).toThrow(RangeError);
  });
});

describe('settlePoints', () => {
  it('returns the difference when the actual cost is lower than the reservation', () => {
    expect(settlePoints(24, 13.4)).toEqual({ chargedPoints: 14, usageDelta: -10 });
  });

  it('changes nothing when the actual cost matches the reservation', () => {
    expect(settlePoints(6, 5.3)).toEqual({ chargedPoints: 6, usageDelta: 0 });
  });

  it('never charges more than was reserved', () => {
    expect(settlePoints(6, 9)).toEqual({ chargedPoints: 6, usageDelta: 0 });
  });

  it('rejects invalid reservations', () => {
    expect(() => settlePoints(-1, 1)).toThrow(RangeError);
    expect(() => settlePoints(1.5, 1)).toThrow(RangeError);
  });
});

describe('refundPoints', () => {
  it('returns every reserved point', () => {
    expect(refundPoints(22)).toEqual({ chargedPoints: 0, usageDelta: -22 });
  });

  it('rejects invalid reservations', () => {
    expect(() => refundPoints(-3)).toThrow(RangeError);
  });
});
