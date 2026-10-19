import { expect, type Locator } from '@playwright/test';

/**
 * Checks that every image the locator matches is served straight from `/static/` and has loaded: a broken or
 * blocked image finishes with a natural width of 0.
 */
export async function expectStaticImagesLoaded(images: Locator, count: number): Promise<void> {
  await expect(images).toHaveCount(count);
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect(image).toHaveAttribute('src', /^\/static\//);
    await expect
      .poll(() =>
        image.evaluate((element: { complete: boolean; naturalWidth: number }) =>
          element.complete ? element.naturalWidth : 0,
        ),
      )
      .toBeGreaterThan(0);
  }
}
