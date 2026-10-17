import { blockingCategory } from '@pictora/core';
import type { Moderate } from '@pictora/providers';
import type { ModerateRequest } from './pipeline.js';

/**
 * The pipeline's moderation hook (tech design 6.3): checks the final prompt, then each input image, with the
 * moderation endpoint, and blocks under Pictora's policy. The first flagged input decides the stage. An error
 * from the endpoint is thrown, so the pipeline fails the job rather than going ahead unchecked.
 */
export function moderateImageRequests(moderate: Moderate): ModerateRequest {
  return async ({ request }) => {
    const promptCategory = blockingCategory(await moderate({ text: request.prompt }));
    if (promptCategory) return { flagged: true, category: promptCategory, stage: 'prompt' };
    const images = [request.inputImage, ...(request.referenceImages ?? [])];
    for (const image of images) {
      if (!image) continue;
      const imageCategory = blockingCategory(await moderate({ image }));
      if (imageCategory) return { flagged: true, category: imageCategory, stage: 'image' };
    }
    return { flagged: false };
  };
}
