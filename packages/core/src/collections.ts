import { z } from 'zod';
import { ulidSchema } from './schemas.js';
import { STYLE_PRESETS, type StyleId } from './styles.js';

/**
 * Collections, tags and gallery search (tech design 4.2, #41). An image sits in at most one collection, like a
 * folder; it carries up to 20 tags of the user's own, and automatic tags from its style and model.
 */

/** Collections a user can have. */
export const MAX_COLLECTIONS = 100;
export const MAX_COLLECTION_NAME_LENGTH = 60;
export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_IMAGE = 20;
/** Images one bulk request may act on; the gallery sends a larger selection in several requests. */
export const MAX_BULK_IMAGES = 50;
export const MAX_SEARCH_LENGTH = 200;
/** Words of a search that count; the rest are ignored. */
export const MAX_SEARCH_TERMS = 10;
/** Longer words are cut to this length, in the index and in a search alike. */
export const MAX_WORD_LENGTH = 40;
/**
 * The version of an image item's search words (`words`). Items without it, made before search existed, are
 * indexed from their versions the first time a search reads them; raising it indexes every image again.
 */
export const SEARCH_INDEX_VERSION = 1;

/** A collection item: `USER#<sub>` / `COL#<collectionId>`. */
export function collectionSk(collectionId: string): string {
  return `COL#${collectionId}`;
}

/** The item that keeps a user's collection names unique, ignoring case: `USER#<sub>` / `COLNAME#<name key>`. */
export function collectionNameSk(name: string): string {
  return `COLNAME#${collectionNameKey(name)}`;
}

/** The GSI1 partition of a collection's images, newest first by `GSI1SK = <imageId>`. */
export function collectionGsiPk(sub: string, collectionId: string): string {
  return `COLIMG#${sub}#${collectionId}`;
}

/** A tag's count item, for suggestions and the tag filter: `USER#<sub>` / `TAG#<tag>`. */
export function tagSk(tag: string): string {
  return `TAG#${tag}`;
}

/** Unicode-normalised, trimmed, with each run of whitespace as one space. */
function tidy(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/** How collection names compare: tidied and in lower case, so `Logos` and `logos ` are the same name. */
export function collectionNameKey(name: string): string {
  return tidy(name).toLowerCase();
}

// Letters, digits, spaces, hyphens and underscores, starting with a letter or digit.
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;
// No control characters in a collection name.
const NAME_PATTERN = /^[^\p{Cc}\p{Cf}]+$/u;

/** A tag as stored: tidied and in lower case. */
export function normaliseTag(tag: string): string {
  return tidy(tag).toLowerCase();
}

export const tagSchema = z
  .string()
  .transform(normaliseTag)
  .pipe(
    z
      .string()
      .min(1, 'Enter a tag.')
      .max(MAX_TAG_LENGTH, `Tags are at most ${MAX_TAG_LENGTH} characters.`)
      .regex(TAG_PATTERN, 'Tags use letters, numbers, spaces, hyphens and underscores.'),
  );

export const collectionNameSchema = z
  .string()
  .transform(tidy)
  .pipe(
    z
      .string()
      .min(1, 'Enter a name.')
      .max(
        MAX_COLLECTION_NAME_LENGTH,
        `Names are at most ${MAX_COLLECTION_NAME_LENGTH} characters.`,
      )
      .regex(NAME_PATTERN, 'Names cannot contain control characters.'),
  );

/** `POST /api/collections` and `PATCH /api/collections/:id`. */
export const collectionRequestSchema = z.strictObject({ name: collectionNameSchema });
export type CollectionRequest = z.infer<typeof collectionRequestSchema>;

const imageIdsSchema = z
  .array(ulidSchema)
  .min(1)
  .max(MAX_BULK_IMAGES)
  .refine((ids) => new Set(ids).size === ids.length, 'Each image may appear once.');

/**
 * `POST /api/images/bulk`: move images to a collection (`null` takes them out of their collection), add or
 * remove a tag, or delete them.
 */
export const bulkRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('move'),
    imageIds: imageIdsSchema,
    collectionId: ulidSchema.nullable(),
  }),
  z.strictObject({ action: z.literal('addTag'), imageIds: imageIdsSchema, tag: tagSchema }),
  z.strictObject({ action: z.literal('removeTag'), imageIds: imageIdsSchema, tag: tagSchema }),
  z.strictObject({ action: z.literal('delete'), imageIds: imageIdsSchema }),
]);
export type BulkRequest = z.infer<typeof bulkRequestSchema>;
export type BulkAction = BulkRequest['action'];

/** `GET /api/images` filters: words to search for, a tag (the user's or an automatic one), a collection. */
export const galleryFilterSchema = z.strictObject({
  q: z.string().max(MAX_SEARCH_LENGTH).optional(),
  tag: z.string().max(64).optional(),
  collection: ulidSchema.optional(),
});
export type GalleryFilter = z.infer<typeof galleryFilterSchema>;

/** Words too common to search by. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'over',
  'that',
  'the',
  'this',
  'to',
  'under',
  'with',
]);

/** The words of a text as search compares them: lower case, accents removed, cut to `MAX_WORD_LENGTH`. */
function tokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.slice(0, MAX_WORD_LENGTH));
}

/**
 * The search words of the texts an image was made with (its prompt, edit instructions and tool prompts): each
 * distinct word once, without stop words and single characters other than digits.
 */
export function searchWords(...texts: (string | undefined)[]): string[] {
  const words = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const word of tokens(text)) {
      if (STOP_WORDS.has(word) || (word.length === 1 && !/\p{N}/u.test(word))) continue;
      words.add(word);
    }
  }
  return [...words];
}

/**
 * The terms of a search, at most `MAX_SEARCH_TERMS`. Stop words are dropped unless the search has nothing else,
 * so searching for `the` still finds titles with it.
 */
export function searchTerms(query: string): string[] {
  const all = [...new Set(tokens(query))];
  const meaningful = all.filter((word) => !STOP_WORDS.has(word));
  return (meaningful.length > 0 ? meaningful : all).slice(0, MAX_SEARCH_TERMS);
}

/** What an image's automatic tags come from. */
export interface AutoTagSource {
  style?: StyleId;
  modelId?: string;
  source?: 'upload';
}

/**
 * An image's automatic tags, as shown: its style's name (unless `None`), its model's display name, and `Upload`
 * for an uploaded image. They are worked out when read, so every image has them, older ones included.
 */
export function autoTags(
  image: AutoTagSource,
  modelNames: Readonly<Record<string, string>>,
): string[] {
  const tags: string[] = [];
  if (image.source === 'upload') tags.push('Upload');
  const style = STYLE_PRESETS.find((preset) => preset.id === image.style);
  if (style && style.id !== 'none') tags.push(style.name);
  const model = image.modelId ? modelNames[image.modelId] : undefined;
  if (model) tags.push(model);
  return tags;
}

/** True when a tag filter names one of the image's tags or automatic tags, ignoring case. */
export function matchesTag(filter: string, tags: readonly string[], auto: readonly string[]) {
  const key = normaliseTag(filter);
  return tags.includes(key) || auto.some((tag) => normaliseTag(tag) === key);
}

/** What a search is ranked on. */
export interface Searchable {
  /** The image's search words (`searchWords`). */
  words: readonly string[];
  /** The user's tags. */
  tags: readonly string[];
  /** The automatic tags, as `autoTags` shows them. */
  autoTags: readonly string[];
}

/** Points a term scores, by how it matched; a term counts its best match only. */
const SCORE = { tagWord: 4, word: 3, tagPrefix: 2, wordPrefix: 1 } as const;

/**
 * Ranks an image for a search: every term must match a word of the image's prompts or tags, whole or as the
 * start of one, or the image is left out (undefined). Whole words score above prefixes, and tags above prompts.
 */
export function searchScore(terms: readonly string[], image: Searchable): number | undefined {
  if (terms.length === 0) return 0;
  const tagWords = new Set([...image.tags, ...image.autoTags].flatMap((tag) => tokens(tag)));
  const words = new Set(image.words);
  let total = 0;
  for (const term of terms) {
    let best = 0;
    if (tagWords.has(term)) best = SCORE.tagWord;
    else if (words.has(term)) best = SCORE.word;
    else if ([...tagWords].some((word) => word.startsWith(term))) best = SCORE.tagPrefix;
    else if ([...words].some((word) => word.startsWith(term))) best = SCORE.wordPrefix;
    if (best === 0) return undefined;
    total += best;
  }
  return total;
}
