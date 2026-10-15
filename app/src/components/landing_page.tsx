import { stylePreset } from '@pictora/core';
import Image from 'next/image';
import { LOGIN_PATH } from '../lib/cognito_oauth';
import { SAMPLE_IMAGE_SIZE, SAMPLE_IMAGES } from '../lib/sample_images';
import { GENERATE_PATH } from '../lib/site';

/** Sign-in, then straight to the generate screen. */
export const START_CREATING_HREF = `${LOGIN_PATH}?returnTo=${encodeURIComponent(GENERATE_PATH)}`;

const STEPS = [
  {
    title: 'Describe it',
    text: 'Type an idea in your own words. The prompt enhancer adds the detail image models need, and you can edit it.',
  },
  {
    title: 'Pick a style',
    text: 'Choose a look, from photorealistic to watercolour, and Pictora picks a model that does it well.',
  },
  {
    title: 'Refine and download',
    text: 'Ask for changes in plain words, keep the versions you like in your private gallery, and download PNGs.',
  },
] as const;

/** The public landing page for signed-out visitors (AUTH-2). A server component: it ships no client code. */
export function LandingPage() {
  return (
    <main className="landing">
      <section className="hero">
        <h1>Turn your ideas into images</h1>
        <p className="hero-pitch">
          Describe what you want to see, pick a style, and get a high-quality PNG in seconds.
        </p>
        {/* A route handler, not a page, so a plain link rather than a prefetching <Link>. */}
        <a href={START_CREATING_HREF} className="button button-primary">
          Start creating
        </a>
      </section>

      <section aria-labelledby="samples-heading">
        <h2 id="samples-heading">Made with Pictora</h2>
        <ul className="sample-grid" aria-label="Sample images by style">
          {SAMPLE_IMAGES.map((sample) => (
            <li key={sample.style}>
              <figure>
                <Image
                  src={sample.src}
                  alt={sample.alt}
                  width={SAMPLE_IMAGE_SIZE}
                  height={SAMPLE_IMAGE_SIZE}
                  sizes="(min-width: 960px) 240px, (min-width: 600px) 33vw, 50vw"
                  unoptimized
                />
                <figcaption>
                  <span className="sample-style">{stylePreset(sample.style).name}</span>
                  <span className="sample-prompt">{sample.prompt}</span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="how-heading">
        <h2 id="how-heading">How it works</h2>
        <ol className="steps">
          {STEPS.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="free-heading" className="free-note">
        <h2 id="free-heading">Free, with a daily allowance</h2>
        <p>
          Pictora costs nothing to use. Every account gets a daily allowance of points to spend on
          images. It resets at midnight UTC, and failed or blocked requests are refunded.
        </p>
        <a href={START_CREATING_HREF} className="button">
          Start creating
        </a>
      </section>
    </main>
  );
}
