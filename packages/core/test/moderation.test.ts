import { describe, expect, it } from 'vitest';
import {
  ALWAYS_BLOCKED_CATEGORIES,
  BLOCKED_CATEGORIES,
  MODERATION_CATEGORIES,
  PROMPT_EXCERPT_LENGTH,
  blockSk,
  blockingCategory,
  modlogPk,
  promptExcerpt,
  type ModerationCategory,
} from '../src/moderation.js';
import { reportRequestSchema } from '../src/schemas.js';

function flaggedFor(...categories: string[]) {
  return {
    flagged: categories.length > 0,
    categories: Object.fromEntries(MODERATION_CATEGORIES.map((c) => [c, categories.includes(c)])),
  };
}

describe('Pictora moderation policy', () => {
  const expected: Record<ModerationCategory, boolean> = {
    sexual: true,
    'sexual/minors': true,
    harassment: false,
    'harassment/threatening': true,
    hate: true,
    'hate/threatening': true,
    illicit: true,
    'illicit/violent': true,
    'self-harm': true,
    'self-harm/intent': true,
    'self-harm/instructions': true,
    violence: false,
    'violence/graphic': true,
  };

  for (const category of MODERATION_CATEGORIES) {
    it(`${expected[category] ? 'blocks' : 'allows'} ${category}`, () => {
      expect(blockingCategory(flaggedFor(category))).toBe(
        expected[category] ? category : undefined,
      );
    });
  }

  it('always blocks sexual content and anything involving minors', () => {
    for (const category of ALWAYS_BLOCKED_CATEGORIES) {
      expect(BLOCKED_CATEGORIES).toContain(category);
      expect(blockingCategory(flaggedFor(category, 'violence'))).toBe(category);
    }
  });

  it('logs the most serious category when several are flagged', () => {
    expect(blockingCategory(flaggedFor('violence/graphic', 'sexual', 'sexual/minors'))).toBe(
      'sexual/minors',
    );
    expect(blockingCategory(flaggedFor('hate', 'violence/graphic'))).toBe('violence/graphic');
  });

  it('allows an unflagged result and categories the endpoint left out', () => {
    expect(blockingCategory(flaggedFor())).toBeUndefined();
    expect(blockingCategory({ flagged: true, categories: {} })).toBeUndefined();
  });
});

describe('moderation items', () => {
  it('builds keys and prompt excerpts', () => {
    expect(blockSk('01J')).toBe('BLOCK#01J');
    expect(modlogPk('2026-10-17')).toBe('MODLOG#2026-10-17');
    expect(promptExcerpt(' a\n\nfox  ')).toBe('a fox');
    expect(promptExcerpt('x'.repeat(500))).toHaveLength(PROMPT_EXCERPT_LENGTH);
  });
});

describe('reportRequestSchema', () => {
  const valid = { imageId: '01JAAAAAAAAAAAAAAAAAAAAAAA', version: 1, reason: 'violence' };

  it('accepts an image version and a listed reason', () => {
    expect(reportRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects anything else', () => {
    for (const bad of [
      { ...valid, imageId: 'nope' },
      { ...valid, version: 0 },
      { ...valid, reason: 'boring' },
      { ...valid, extra: true },
      { imageId: valid.imageId, version: 1 },
    ]) {
      expect(reportRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});
