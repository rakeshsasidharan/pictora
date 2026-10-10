import { findModel, loadSeedRegistry, type ModelConfig } from '@pictora/core';
import sharp from 'sharp';
import type { ImageRequest } from '../src/types.js';

export function seedModel(id: string): ModelConfig {
  const model = findModel(loadSeedRegistry(), id);
  if (!model) throw new Error(`No seed model ${id}`);
  return model;
}

export function request(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    prompt: 'a lighthouse at dusk',
    aspect: '1:1',
    quality: 'draft',
    count: 1,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A solid-colour test image in the given format. */
export async function solidImage(
  format: 'jpeg' | 'webp' | 'png',
  width: number,
  height: number,
): Promise<Uint8Array> {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } },
  });
  return new Uint8Array(await image.toFormat(format).toBuffer());
}

/** An HTTP-style error as SDKs throw them. */
export function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}
