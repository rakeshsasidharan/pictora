import { describe, expect, it } from 'vitest';
import {
  MAX_BULK_IMAGES,
  MAX_SEARCH_TERMS,
  autoTags,
  bulkRequestSchema,
  collectionGsiPk,
  collectionNameKey,
  collectionNameSchema,
  collectionNameSk,
  collectionRequestSchema,
  collectionSk,
  galleryFilterSchema,
  matchesTag,
  normaliseTag,
  searchScore,
  searchTerms,
  searchWords,
  tagSchema,
  tagSk,
  type Searchable,
} from '../src/collections.js';

const ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const idOf = (n: number) => `01J${String(n).padStart(23, '0')}`;

describe('keys', () => {
  it('keeps collections, their names, tags and the collection index apart', () => {
    expect(collectionSk(ID)).toBe(`COL#${ID}`);
    expect(collectionNameSk('  My   Logos ')).toBe('COLNAME#my logos');
    expect(tagSk('sunset')).toBe('TAG#sunset');
    expect(collectionGsiPk('sub-1', ID)).toBe(`COLIMG#sub-1#${ID}`);
  });

  it('compares collection names ignoring case, spacing and Unicode form', () => {
    expect(collectionNameKey('Café')).toBe(collectionNameKey('café'.normalize('NFD')));
    expect(collectionNameKey('LOGOS')).toBe(collectionNameKey(' logos '));
  });
});

describe('tags', () => {
  it('stores a tag tidied and in lower case', () => {
    expect(normaliseTag('  Sunset   Beach ')).toBe('sunset beach');
    expect(tagSchema.parse('Hero_Image-2')).toBe('hero_image-2');
  });

  it.each([
    ['', 'Enter a tag.'],
    ['   ', 'Enter a tag.'],
    ['x'.repeat(33), 'Tags are at most 32 characters.'],
    ['#hash', 'Tags use letters, numbers, spaces, hyphens and underscores.'],
    ['_leading', 'Tags use letters, numbers, spaces, hyphens and underscores.'],
    ['a.b', 'Tags use letters, numbers, spaces, hyphens and underscores.'],
  ])('refuses %j', (tag, message) => {
    const parsed = tagSchema.safeParse(tag);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(message);
  });

  it('accepts letters and digits of any script', () => {
    expect(tagSchema.parse('été 2026')).toBe('été 2026');
    expect(tagSchema.parse('東京')).toBe('東京');
  });
});

describe('collection names', () => {
  it('tidies a name but keeps its case', () => {
    expect(collectionNameSchema.parse('  Client   X  ')).toBe('Client X');
  });

  it('refuses an empty name, a long one or control characters', () => {
    expect(collectionNameSchema.safeParse(' ').success).toBe(false);
    expect(collectionNameSchema.safeParse('x'.repeat(61)).success).toBe(false);
    expect(collectionNameSchema.safeParse('bad\u0007name').success).toBe(false);
    expect(collectionNameSchema.safeParse('x'.repeat(60)).success).toBe(true);
  });

  it('takes nothing but the name', () => {
    expect(collectionRequestSchema.safeParse({ name: 'Logos', extra: 1 }).success).toBe(false);
  });
});

describe('bulkRequestSchema', () => {
  it('reads each action', () => {
    expect(bulkRequestSchema.parse({ action: 'move', imageIds: [ID], collectionId: null })).toEqual(
      { action: 'move', imageIds: [ID], collectionId: null },
    );
    expect(bulkRequestSchema.parse({ action: 'addTag', imageIds: [ID], tag: ' Sky ' })).toEqual({
      action: 'addTag',
      imageIds: [ID],
      tag: 'sky',
    });
    expect(bulkRequestSchema.parse({ action: 'delete', imageIds: [ID] }).action).toBe('delete');
  });

  it(`takes 1 to ${MAX_BULK_IMAGES} distinct image IDs`, () => {
    const ids = (count: number) => Array.from({ length: count }, (_, n) => idOf(n + 1));
    expect(bulkRequestSchema.safeParse({ action: 'delete', imageIds: [] }).success).toBe(false);
    expect(bulkRequestSchema.safeParse({ action: 'delete', imageIds: ids(50) }).success).toBe(true);
    expect(bulkRequestSchema.safeParse({ action: 'delete', imageIds: ids(51) }).success).toBe(
      false,
    );
    expect(bulkRequestSchema.safeParse({ action: 'delete', imageIds: [ID, ID] }).success).toBe(
      false,
    );
    expect(bulkRequestSchema.safeParse({ action: 'delete', imageIds: ['../x'] }).success).toBe(
      false,
    );
  });

  it('refuses an unknown action, a missing field or an extra one', () => {
    expect(bulkRequestSchema.safeParse({ action: 'rename', imageIds: [ID] }).success).toBe(false);
    expect(bulkRequestSchema.safeParse({ action: 'move', imageIds: [ID] }).success).toBe(false);
    expect(
      bulkRequestSchema.safeParse({ action: 'delete', imageIds: [ID], tag: 'x' }).success,
    ).toBe(false);
  });
});

describe('galleryFilterSchema', () => {
  it('checks the search length and the collection ID', () => {
    expect(
      galleryFilterSchema.safeParse({ q: 'fox', tag: 'Watercolour', collection: ID }).success,
    ).toBe(true);
    expect(galleryFilterSchema.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
    expect(galleryFilterSchema.safeParse({ collection: 'nope' }).success).toBe(false);
  });
});

describe('searchWords', () => {
  it('keeps each distinct word once, in lower case without accents or stop words', () => {
    expect(
      searchWords('A Red fox in the snow, at dusk', 'Make the fox RED', undefined, 'Café crème'),
    ).toEqual(['red', 'fox', 'snow', 'dusk', 'make', 'cafe', 'creme']);
  });

  it('drops single letters but keeps digits', () => {
    expect(searchWords('a b c 3 d 42')).toEqual(['3', '42']);
  });

  it('cuts long words to 40 characters', () => {
    expect(searchWords('x'.repeat(60))).toEqual(['x'.repeat(40)]);
  });
});

describe('searchTerms', () => {
  it('splits the query the way words are stored', () => {
    expect(searchTerms('  Red FOXES, café ')).toEqual(['red', 'foxes', 'cafe']);
  });

  it('drops stop words unless nothing else is left', () => {
    expect(searchTerms('the fox')).toEqual(['fox']);
    expect(searchTerms('the')).toEqual(['the']);
  });

  it(`keeps at most ${MAX_SEARCH_TERMS} terms`, () => {
    expect(searchTerms(Array.from({ length: 15 }, (_, n) => `w${n}`).join(' '))).toHaveLength(
      MAX_SEARCH_TERMS,
    );
  });
});

describe('autoTags', () => {
  const names = { 'gemini-3-pro-image': 'Gemini 3 Pro Image' };

  it("names the image's style and model", () => {
    expect(autoTags({ style: 'watercolour', modelId: 'gemini-3-pro-image' }, names)).toEqual([
      'Watercolour',
      'Gemini 3 Pro Image',
    ]);
  });

  it('marks uploads, and leaves out the None style and models the registry no longer has', () => {
    expect(autoTags({ source: 'upload' }, names)).toEqual(['Upload']);
    expect(autoTags({ style: 'none', modelId: 'retired-model' }, names)).toEqual([]);
  });

  it('matches a tag filter against the tags and the automatic tags, ignoring case', () => {
    expect(matchesTag('Logos', ['logos'], [])).toBe(true);
    expect(matchesTag('watercolour', [], ['Watercolour'])).toBe(true);
    expect(matchesTag('gemini 3 pro image', [], ['Gemini 3 Pro Image'])).toBe(true);
    expect(matchesTag('logo', ['logos'], [])).toBe(false);
  });
});

describe('searchScore on fixture data', () => {
  const images: Record<string, Searchable> = {
    foxTagged: { words: ['sleepy', 'animal', 'forest'], tags: ['fox'], autoTags: ['Watercolour'] },
    foxPrompt: { words: ['red', 'fox', 'snow'], tags: [], autoTags: ['Photorealistic'] },
    foxPrefix: { words: ['foxglove', 'garden'], tags: [], autoTags: [] },
    foxTagPrefix: { words: ['meadow'], tags: ['foxhound puppies'], autoTags: [] },
    city: { words: ['neon', 'city', 'night'], tags: ['cyberpunk'], autoTags: ['Cinematic'] },
  };
  const rank = (query: string) =>
    Object.entries(images)
      .map(([name, image]) => ({ name, score: searchScore(searchTerms(query), image) }))
      .filter((result) => result.score !== undefined)
      .sort((a, b) => b.score! - a.score!)
      .map((result) => result.name);

  it('ranks a whole tag, then a whole prompt word, then a tag prefix, then a prompt prefix', () => {
    expect(rank('fox')).toEqual(['foxTagged', 'foxPrompt', 'foxTagPrefix', 'foxPrefix']);
  });

  it('needs every word to match', () => {
    expect(rank('red fox')).toEqual(['foxPrompt']);
    expect(rank('fox city')).toEqual([]);
  });

  it('matches automatic tags and multi-word tags word by word', () => {
    expect(rank('watercolour')).toEqual(['foxTagged']);
    expect(rank('puppies')).toEqual(['foxTagPrefix']);
    expect(rank('cinema')).toEqual(['city']);
  });

  it('scores an empty search as a match for everything', () => {
    expect(searchScore([], images.city!)).toBe(0);
  });
});
