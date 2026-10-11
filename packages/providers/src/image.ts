import { ASPECT_RATIOS, centreCropSize, type Aspect, type Size } from '@pictora/core';
import sharp from 'sharp';

/** Gallery thumbnails: 512 px on the longest side, WebP (tech design 9). */
export const THUMBNAIL_MAX_PX = 512;
export const THUMBNAIL_WEBP_QUALITY = 80;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface NormalisedImage {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface Thumbnail {
  webp: Uint8Array;
  width: number;
  height: number;
}

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * Returns the image as PNG with its size. A PNG is passed through byte for byte, so provenance chunks such
 * as C2PA survive. Any other format is converted losslessly, keeping its EXIF, XMP, IPTC and ICC metadata.
 */
export async function normalisePng(bytes: Uint8Array): Promise<NormalisedImage> {
  if (isPng(bytes)) {
    const { width, height } = await dimensions(bytes);
    return { png: bytes, width, height };
  }
  const { data, info } = await sharp(bytes)
    .keepMetadata()
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return { png: new Uint8Array(data), width: info.width, height: info.height };
}

/** A WebP thumbnail no larger than 512 px on its longest side. Smaller images are not enlarged. */
export async function thumbnail(bytes: Uint8Array): Promise<Thumbnail> {
  const { data, info } = await sharp(bytes)
    .resize(THUMBNAIL_MAX_PX, THUMBNAIL_MAX_PX, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { webp: new Uint8Array(data), width: info.width, height: info.height };
}

/**
 * Centre-crops an image to the aspect's exact ratio, for models without a native size for it (GEN-3).
 * The result is PNG with metadata kept; an image already at the ratio is returned unchanged.
 */
export async function centreCrop(bytes: Uint8Array, aspect: Aspect): Promise<NormalisedImage> {
  const size = await dimensions(bytes);
  const target = centreCropSize(size, ASPECT_RATIOS[aspect]);
  if (target.width === size.width && target.height === size.height) return normalisePng(bytes);

  const { data, info } = await sharp(bytes)
    .extract({
      left: Math.floor((size.width - target.width) / 2),
      top: Math.floor((size.height - target.height) / 2),
      width: target.width,
      height: target.height,
    })
    .keepMetadata()
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return { png: new Uint8Array(data), width: info.width, height: info.height };
}

async function dimensions(bytes: Uint8Array): Promise<Size> {
  const { width, height } = await sharp(bytes).metadata();
  if (!width || !height) throw new Error('Image has no dimensions');
  return { width, height };
}
