import type { StyleId } from '@pictora/core';

/** One image in the landing page's sample grid (AUTH-2). */
export interface SampleImage {
  style: Exclude<StyleId, 'none'>;
  /** The prompt the image was made from, shown under it. */
  prompt: string;
  /** Under `public/static/`, so CloudFront serves it from the assets bucket. */
  src: `/static/samples/${string}.webp`;
  alt: string;
}

/** Sample images are square WebP files of this size, kept under about 60 KB each for a fast landing page. */
export const SAMPLE_IMAGE_SIZE = 512;

/**
 * The landing page's samples, one per style preset in picker order. Each file is an image we generated with
 * Pictora from the prompt shown; replacing a file needs no code change as long as its name stays the same.
 * `npm run generate:samples` regenerates them with each style's suggested model (`-- --style <id>` for one).
 */
export const SAMPLE_IMAGES: readonly SampleImage[] = [
  {
    style: 'photorealistic',
    prompt: 'A golden retriever puppy asleep on a knitted blanket by a sunny window',
    src: '/static/samples/photorealistic.webp',
    alt: 'A golden retriever puppy asleep on a knitted blanket in warm window light',
  },
  {
    style: 'cinematic',
    prompt: 'A lone astronaut walking through a neon-lit night market in the rain',
    src: '/static/samples/cinematic.webp',
    alt: 'An astronaut walking through a rainy night market lit by neon signs',
  },
  {
    style: 'digital-art',
    prompt: 'A floating island city with waterfalls pouring into the clouds at sunrise',
    src: '/static/samples/digital_art.webp',
    alt: 'A city on a floating island with waterfalls spilling into clouds at sunrise',
  },
  {
    style: 'anime',
    prompt: 'A girl on a bicycle racing a summer train along the coast',
    src: '/static/samples/anime.webp',
    alt: 'An anime girl riding a bicycle beside a train on a coastal road in summer',
  },
  {
    style: 'watercolour',
    prompt: 'A quiet harbour town with fishing boats at dawn',
    src: '/static/samples/watercolour.webp',
    alt: 'A watercolour of a small harbour town with fishing boats in soft dawn light',
  },
  {
    style: 'oil-painting',
    prompt: 'A still life of lemons, a copper jug and a blue cloth on a wooden table',
    src: '/static/samples/oil_painting.webp',
    alt: 'An oil painting of lemons, a copper jug and a blue cloth on a wooden table',
  },
  {
    style: '3d-render',
    prompt: 'A tiny cosy treehouse library inside a glass terrarium',
    src: '/static/samples/3d_render.webp',
    alt: 'A miniature treehouse library with shelves of books inside a glass terrarium',
  },
  {
    style: 'line-art',
    prompt: 'A hummingbird drinking from a hibiscus flower',
    src: '/static/samples/line_art.webp',
    alt: 'Black ink line drawing of a hummingbird drinking from a hibiscus flower',
  },
];
