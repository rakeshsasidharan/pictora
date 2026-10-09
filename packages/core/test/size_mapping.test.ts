import { describe, expect, it } from 'vitest';
import {
  ASPECTS,
  ASPECT_RATIOS,
  QUALITIES,
  centreCropSize,
  loadSeedRegistry,
  mapAspect,
  type Aspect,
  type ModelConfig,
  type Size,
} from '../src/index.js';

const models = loadSeedRegistry();

function model(id: string): ModelConfig {
  const found = models.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing model ${id}`);
  return found;
}

const OPENAI_EXPECTED: Record<Aspect, { providerSize: string; output: Size; crop: boolean }> = {
  '1:1': { providerSize: '1024x1024', output: { width: 1024, height: 1024 }, crop: false },
  '4:5': { providerSize: '1024x1536', output: { width: 1024, height: 1280 }, crop: true },
  '3:2': { providerSize: '1536x1024', output: { width: 1536, height: 1024 }, crop: false },
  '2:3': { providerSize: '1024x1536', output: { width: 1024, height: 1536 }, crop: false },
  '16:9': { providerSize: '1536x1024', output: { width: 1536, height: 864 }, crop: true },
  '9:16': { providerSize: '1024x1536', output: { width: 864, height: 1536 }, crop: true },
};

const GEMINI_1K: Record<Aspect, Size> = {
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 928, height: 1152 },
  '3:2': { width: 1264, height: 848 },
  '2:3': { width: 848, height: 1264 },
  '16:9': { width: 1376, height: 768 },
  '9:16': { width: 768, height: 1376 },
};

describe('mapAspect', () => {
  for (const id of ['gpt-image-2', 'gpt-image-1-mini']) {
    for (const aspect of ASPECTS) {
      const expected = OPENAI_EXPECTED[aspect];
      it(`maps ${aspect} on ${id} to ${expected.providerSize}${expected.crop ? ', centre-cropped' : ''}`, () => {
        const entry = model(id);
        for (const quality of QUALITIES.filter((candidate) => entry.qualities[candidate])) {
          const mapping = mapAspect(entry, aspect, quality);
          const [width, height] = expected.providerSize.split('x').map(Number);
          expect(mapping).toEqual({ aspect, ...expected, generated: { width, height } });
        }
      });
    }
  }

  const geminiCases: [string, (typeof QUALITIES)[number], number][] = [
    ['gemini-3.1-flash-image', 'standard', 1],
    ['gemini-3.1-flash-image', 'high', 2],
    ['gemini-3.1-flash-lite-image', 'draft', 1],
    ['gemini-3-pro-image', 'standard', 2],
    ['gemini-3-pro-image', 'high', 4],
    ['mock', 'draft', 1],
    ['mock', 'high', 1],
  ];
  for (const [id, quality, scale] of geminiCases) {
    for (const aspect of ASPECTS) {
      it(`maps ${aspect} on ${id} at ${quality} to a native ${scale}K size with no crop`, () => {
        const mapping = mapAspect(model(id), aspect, quality);
        expect(mapping.providerSize).toBe(aspect);
        expect(mapping.crop).toBe(false);
        expect(mapping.output).toEqual(mapping.generated);
        const base = GEMINI_1K[aspect];
        // Gemini sizes are close to, not exactly, a multiple of the 1K size.
        expect(mapping.generated.width / base.width).toBeCloseTo(scale, 0);
        expect(mapping.generated.height / base.height).toBeCloseTo(scale, 0);
        if (scale === 1) expect(mapping.generated).toEqual(base);
      });
    }
  }

  it('keeps every output close to the requested aspect ratio', () => {
    for (const entry of models) {
      for (const quality of QUALITIES.filter((candidate) => entry.qualities[candidate])) {
        for (const aspect of entry.capabilities.aspects) {
          const { output } = mapAspect(entry, aspect, quality);
          expect(Math.abs(output.width / output.height - ASPECT_RATIOS[aspect])).toBeLessThan(0.02);
        }
      }
    }
  });

  it('rejects a quality the model does not offer', () => {
    expect(() => mapAspect(model('gpt-image-1-mini'), '1:1', 'high')).toThrow(
      /does not support quality high/,
    );
  });

  it('rejects an unknown Gemini imageSize', () => {
    const entry = model('gemini-3-pro-image');
    const broken: ModelConfig = {
      ...entry,
      qualities: { standard: { providerParams: { imageSize: '8K' }, costPoints: 14 } },
    };
    expect(() => mapAspect(broken, '1:1', 'standard')).toThrow(/unknown imageSize: 8K/);
  });

  it('has no size table for Bedrock yet', () => {
    const bedrock: ModelConfig = { ...model('mock'), id: 'stable-image-core', provider: 'bedrock' };
    expect(() => mapAspect(bedrock, '1:1', 'draft')).toThrow(/Bedrock sizes are not mapped/);
  });
});

describe('centreCropSize', () => {
  it('keeps a size that already has the ratio', () => {
    expect(centreCropSize({ width: 1536, height: 1024 }, 3 / 2)).toEqual({
      width: 1536,
      height: 1024,
    });
  });

  it('trims the width of a size that is too wide', () => {
    expect(centreCropSize({ width: 1024, height: 1024 }, 4 / 5)).toEqual({
      width: 819,
      height: 1024,
    });
  });

  it('trims the height of a size that is too tall', () => {
    expect(centreCropSize({ width: 1024, height: 1024 }, 16 / 9)).toEqual({
      width: 1024,
      height: 576,
    });
  });
});
