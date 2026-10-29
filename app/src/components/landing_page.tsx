import { stylePreset } from '@pictora/core';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

const SECTION_HEADING_CLASS = 'mb-4 text-2xl font-semibold tracking-tight';

/** The public landing page for signed-out visitors (AUTH-2). A server component: it ships no client code. */
export function LandingPage() {
  return (
    <main
      data-slot="landing-page"
      className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 pt-8 pb-12 sm:gap-16 sm:pt-12"
    >
      <section className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Turn your ideas into images
        </h1>
        <p className="max-w-xl text-lg text-balance text-muted-foreground">
          Describe what you want to see, pick a style, and get a high-quality PNG in seconds.
        </p>
        <Button asChild size="lg" className="mt-2">
          {/* A route handler, not a page, so a plain link rather than a prefetching <Link>. */}
          <a href={START_CREATING_HREF}>Start creating</a>
        </Button>
      </section>

      <section aria-labelledby="samples-heading">
        <h2 id="samples-heading" className={SECTION_HEADING_CLASS}>
          Made with Pictora
        </h2>
        <ul
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4"
          aria-label="Sample images by style"
        >
          {SAMPLE_IMAGES.map((sample) => (
            <li key={sample.style} className="min-w-0">
              <Card className="h-full gap-0 overflow-hidden py-0">
                <figure className="flex h-full flex-col">
                  <Image
                    src={sample.src}
                    alt={sample.alt}
                    width={SAMPLE_IMAGE_SIZE}
                    height={SAMPLE_IMAGE_SIZE}
                    sizes="(min-width: 1024px) 240px, (min-width: 640px) 33vw, 50vw"
                    className="aspect-square w-full bg-muted object-cover"
                    unoptimized
                  />
                  <figcaption className="flex flex-col gap-0.5 p-3 text-sm">
                    <span className="font-medium">{stylePreset(sample.style).name}</span>
                    <span className="text-muted-foreground">{sample.prompt}</span>
                  </figcaption>
                </figure>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="how-heading">
        <h2 id="how-heading" className={SECTION_HEADING_CLASS}>
          How it works
        </h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <Card className="h-full gap-2">
                <CardHeader className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
                  >
                    {index + 1}
                  </span>
                  <CardTitle>
                    <h3 className="text-lg">{step.title}</h3>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-base">{step.text}</CardDescription>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="free-heading">
        <Card className="items-center bg-muted/50 px-6 text-center">
          <h2 id="free-heading" className="text-2xl font-semibold tracking-tight">
            Free, with a daily allowance
          </h2>
          <p className="max-w-2xl text-muted-foreground">
            Pictora costs nothing to use. Every account gets a daily allowance of points to spend on
            images. It resets at midnight UTC, and failed or blocked requests are refunded.
          </p>
          <Button asChild variant="outline" size="lg">
            <a href={START_CREATING_HREF}>Start creating</a>
          </Button>
        </Card>
      </section>
    </main>
  );
}
