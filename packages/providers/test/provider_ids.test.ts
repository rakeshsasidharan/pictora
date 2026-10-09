import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, isProviderId } from '../src/index.js';

describe('provider ids', () => {
  it('lists every provider once', () => {
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
  });

  it('recognises known providers and rejects unknown ones', () => {
    expect(isProviderId('openai')).toBe(true);
    expect(isProviderId('gemini')).toBe(true);
    expect(isProviderId('dall-e')).toBe(false);
  });
});
