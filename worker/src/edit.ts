import { GetObjectCommand, NoSuchKey, type S3Client } from '@aws-sdk/client-s3';
import {
  nearestAspect,
  parseReferenceKey,
  type Aspect,
  type EditJobRequest,
  type ModelConfig,
} from '@pictora/core';
import { NotAnImageError, prepareUpload } from '@pictora/providers';
import { loadVersion, type TableContext } from './job_store.js';

/** What an edit sends the provider besides the instruction (tech design 5.3). */
export interface EditInputs {
  /** The parent version's PNG. */
  parent: Uint8Array;
  /** The reference images, in the order the user added them. */
  references: Uint8Array[];
  /** The aspect to ask for: the parent's own when the model offers it, otherwise the nearest one it does. */
  aspect: Aspect;
}

/** The parent version or a reference image is gone (deleted, expired or never there); the job is refunded. */
export class EditSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EditSourceError';
  }
}

export interface EditSourceDeps extends TableContext {
  s3: S3Client;
  bucket: string;
}

/**
 * Loads what an edit needs from DynamoDB and S3: the parent version of the user's own image, and each reference
 * image. A reference is either a version of one of the user's images or an upload that was never completed,
 * which is decoded and turned upright as an upload is. Anything missing, or not the user's, throws
 * `EditSourceError`; the app checked ownership already, so that only happens when something was deleted or
 * expired while the job waited.
 */
export async function loadEditInputs(
  deps: EditSourceDeps,
  sub: string,
  request: EditJobRequest,
  model: ModelConfig,
): Promise<EditInputs> {
  const source = await loadVersion(deps, sub, request.imageId, request.parentVersion);
  if (!source) throw new EditSourceError('Parent version not found');
  const parent = await readObject(deps, source.s3Key);
  if (!parent) throw new EditSourceError('Parent image not found in S3');

  const keys = (request.referenceKeys ?? []).slice(0, model.capabilities.referenceImages);
  const references = await Promise.all(keys.map((key) => loadReference(deps, sub, key)));

  const aspects = model.capabilities.aspects;
  const aspect =
    source.aspect && aspects.includes(source.aspect)
      ? source.aspect
      : nearestAspect({ width: source.width, height: source.height }, aspects);
  return { parent, references, aspect };
}

async function loadReference(deps: EditSourceDeps, sub: string, key: string): Promise<Uint8Array> {
  const reference = parseReferenceKey(key);
  if (!reference || reference.sub !== sub) throw new EditSourceError('Reference not owned');
  if (reference.kind === 'version') {
    const version = await loadVersion(deps, sub, reference.imageId, reference.version);
    const bytes = version && (await readObject(deps, version.s3Key));
    if (!bytes) throw new EditSourceError('Reference version not found');
    return bytes;
  }
  const bytes = await readObject(deps, key);
  if (!bytes) throw new EditSourceError('Reference upload not found');
  try {
    return (await prepareUpload(bytes)).png;
  } catch (error) {
    if (error instanceof NotAnImageError) {
      throw new EditSourceError('Reference upload is not an image', { cause: error });
    }
    throw error;
  }
}

async function readObject(deps: EditSourceDeps, key: string): Promise<Uint8Array | undefined> {
  try {
    const object = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: key }));
    return object.Body ? await object.Body.transformToByteArray() : undefined;
  } catch (error) {
    if (error instanceof NoSuchKey) return undefined;
    throw error;
  }
}
