import {
  ASPECTS,
  nearestAspect,
  parseReferenceKey,
  toolIdFor,
  type Aspect,
  type ToolId,
  type ToolJobRequest,
} from '@pictora/core';
import {
  prepareMask,
  prepareToolImage,
  type NormalisedImage,
  type ToolRequest,
} from '@pictora/providers';
import { EditSourceError, readObject, type EditSourceDeps } from './edit.js';
import { loadVersion } from './job_store.js';

/** What a tool job sends the provider (tech design 5.5). */
export interface ToolInputs {
  toolId: ToolId;
  /** The source version, scaled down to fit the tool's limits. */
  image: NormalisedImage;
  /** The provider request, without its abort signal. */
  request: Omit<ToolRequest, 'signal'>;
  /** The prompt the user gave the tool, trimmed; empty for none. */
  prompt: string;
}

/**
 * Loads what a tool job needs from DynamoDB and S3: the source version of the user's own image, scaled to fit the
 * tool (`prepareToolImage`, which throws `ToolInputError` for an image the tool can't take), and for an erase
 * the mask the user drew, from its upload, encoded as a black and white PNG at the image's size. A version or
 * mask that is gone, or not the user's, throws `EditSourceError`; the app checked ownership already, so that
 * only happens when something was deleted or expired while the job waited.
 */
export async function loadToolInputs(
  deps: EditSourceDeps,
  sub: string,
  request: ToolJobRequest,
): Promise<ToolInputs> {
  const toolId = toolIdFor(request);
  const source = await loadVersion(deps, sub, request.imageId, request.version);
  if (!source) throw new EditSourceError('Source version not found');
  const bytes = await readObject(deps, source.s3Key);
  if (!bytes) throw new EditSourceError('Source image not found in S3');
  const image = await prepareToolImage(toolId, bytes);

  const base = { tool: toolId, image: image.png };
  switch (request.tool) {
    case 'upscale': {
      const prompt = request.params.prompt?.trim() ?? '';
      return { toolId, image, prompt, request: { ...base, prompt } };
    }
    case 'remove-background':
      return { toolId, image, prompt: '', request: base };
    case 'erase': {
      const key = parseReferenceKey(request.params.maskKey);
      if (key?.kind !== 'upload' || key.sub !== sub) throw new EditSourceError('Mask not owned');
      const drawn = await readObject(deps, request.params.maskKey);
      if (!drawn) throw new EditSourceError('Mask upload not found');
      let mask: Uint8Array;
      try {
        mask = await prepareMask(drawn, image);
      } catch (error) {
        throw new EditSourceError('Mask upload is not an image', { cause: error });
      }
      return {
        toolId,
        image,
        prompt: '',
        request: {
          ...base,
          mask,
          ...(request.params.growMask !== undefined ? { growMask: request.params.growMask } : {}),
        },
      };
    }
    case 'outpaint': {
      const { left, right, up, down } = request.params;
      const prompt = request.params.prompt?.trim() ?? '';
      return {
        toolId,
        image,
        prompt,
        request: { ...base, outpaint: { left, right, up, down }, ...(prompt ? { prompt } : {}) },
      };
    }
  }
}

/** The aspect a tool's result is recorded with: the nearest Pictora aspect to its shape. */
export function toolResultAspect(size: { width: number; height: number }): Aspect {
  return nearestAspect(size, ASPECTS);
}
