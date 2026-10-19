import { ASPECT_RATIOS, centreCropSize, type Aspect, type Size } from '@pictora/core';
import sharp, { type OutputInfo } from 'sharp';

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

/** Formats an upload may be in (EDIT-2), as `sharp` names them. */
export const UPLOAD_FORMATS = ['jpeg', 'png', 'webp'] as const;
/** Uploads are scaled down to fit 4096 px, the largest output size tier, so edits stay within provider limits. */
export const UPLOAD_MAX_PX = 4096;
/** Uploads over 50 megapixels are refused before decoding, so a small file can't expand into a huge image. */
export const UPLOAD_MAX_INPUT_PIXELS = 50_000_000;
/** The copy sent to moderation: 1024 px on the longest side, as JPEG, to keep the request small. */
export const MODERATION_COPY_PX = 1024;
const MODERATION_COPY_JPEG_QUALITY = 85;

/** The upload isn't a JPEG, PNG or WebP image that can be decoded. */
export class NotAnImageError extends Error {
  constructor(message = 'The file is not a JPEG, PNG or WebP image', options?: ErrorOptions) {
    super(message, options);
    this.name = 'NotAnImageError';
  }
}

/** An upload ready to store: the PNG, its thumbnail and a small copy to moderate. */
export interface PreparedUpload extends NormalisedImage {
  thumbnail: Thumbnail;
  moderationCopy: Uint8Array;
}

/**
 * Decodes an uploaded image (EDIT-2) and turns it into version 1 of a new image: a PNG turned upright from its
 * EXIF orientation and scaled down to fit 4096 px. Its metadata is dropped, so a photo's location doesn't stay
 * with it. Throws `NotAnImageError` for anything that isn't a decodable JPEG, PNG or WebP.
 */
export async function prepareUpload(bytes: Uint8Array): Promise<PreparedUpload> {
  const input = () => sharp(bytes, { limitInputPixels: UPLOAD_MAX_INPUT_PIXELS });
  let png: { data: Buffer; info: OutputInfo };
  try {
    const { format } = await input().metadata();
    if (!(UPLOAD_FORMATS as readonly string[]).includes(format)) throw new NotAnImageError();
    png = await input()
      .rotate()
      .resize(UPLOAD_MAX_PX, UPLOAD_MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof NotAnImageError) throw error;
    throw new NotAnImageError(undefined, { cause: error });
  }
  const pngBytes = new Uint8Array(png.data);
  const moderationCopy = await sharp(pngBytes)
    .resize(MODERATION_COPY_PX, MODERATION_COPY_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: MODERATION_COPY_JPEG_QUALITY })
    .toBuffer();
  return {
    png: pngBytes,
    width: png.info.width,
    height: png.info.height,
    thumbnail: await thumbnail(pngBytes),
    moderationCopy: new Uint8Array(moderationCopy),
  };
}
