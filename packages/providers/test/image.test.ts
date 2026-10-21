import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  MODERATION_COPY_PX,
  NotAnImageError,
  THUMBNAIL_MAX_PX,
  UPLOAD_MAX_PX,
  centreCrop,
  isPng,
  normalisePng,
  prepareUpload,
  thumbnail,
} from '../src/image.js';
import { solidImage } from './helpers.js';

describe('normalisePng', () => {
  it.each(['jpeg', 'webp'] as const)(
    'converts %s input to PNG and reports its size',
    async (format) => {
      const input = await solidImage(format, 300, 200);
      expect(isPng(input)).toBe(false);

      const result = await normalisePng(input);

      expect(isPng(result.png)).toBe(true);
      expect(result).toMatchObject({ width: 300, height: 200 });
      const metadata = await sharp(result.png).metadata();
      expect(metadata).toMatchObject({ format: 'png', width: 300, height: 200 });
    },
  );

  it('passes PNG input through unchanged', async () => {
    const input = await solidImage('png', 64, 32);
    const result = await normalisePng(input);
    expect(result.png).toBe(input);
    expect(result).toMatchObject({ width: 64, height: 32 });
  });

  it('keeps metadata when converting', async () => {
    const jpeg = new Uint8Array(
      await sharp(await solidImage('jpeg', 40, 40))
        .withExif({ IFD0: { Copyright: 'Pictora test' } })
        .jpeg()
        .toBuffer(),
    );
    const result = await normalisePng(jpeg);
    const { exif } = await sharp(result.png).metadata();
    expect(exif?.toString('latin1')).toContain('Pictora test');
  });
});

describe('thumbnail', () => {
  it.each([
    [1536, 1024, 512, 341],
    [1024, 1536, 341, 512],
    [2048, 2048, 512, 512],
  ])('fits %ix%i inside 512 px as WebP', async (width, height, thumbWidth, thumbHeight) => {
    const result = await thumbnail(await solidImage('png', width, height));
    expect(result).toMatchObject({ width: thumbWidth, height: thumbHeight });
    const metadata = await sharp(result.webp).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: thumbWidth, height: thumbHeight });
  });

  it('does not enlarge small images', async () => {
    const result = await thumbnail(await solidImage('png', 200, 100));
    expect(result).toMatchObject({ width: 200, height: 100 });
  });
});

describe('centreCrop', () => {
  it.each([
    ['16:9', 1536, 1024, 1536, 864],
    ['4:5', 1024, 1024, 819, 1024],
    ['9:16', 1024, 1536, 864, 1536],
    ['2:3', 1024, 1536, 1024, 1536],
  ] as const)('crops to %s: %ix%i → %ix%i', async (aspect, width, height, outWidth, outHeight) => {
    const result = await centreCrop(await solidImage('png', width, height), aspect);
    expect(result).toMatchObject({ width: outWidth, height: outHeight });
    expect(await sharp(result.png).metadata()).toMatchObject({
      format: 'png',
      width: outWidth,
      height: outHeight,
    });
  });

  it('takes the centre of the image', async () => {
    // A 30x10 image: red, green and blue thirds. Cropping to 1:1 keeps only the green middle.
    const third = (r: number, g: number, b: number) => ({
      input: { create: { width: 10, height: 10, channels: 3 as const, background: { r, g, b } } },
    });
    const striped = await sharp({
      create: { width: 30, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        { ...third(255, 0, 0), left: 0, top: 0 },
        { ...third(0, 255, 0), left: 10, top: 0 },
        { ...third(0, 0, 255), left: 20, top: 0 },
      ])
      .png()
      .toBuffer();

    const result = await centreCrop(new Uint8Array(striped), '1:1');
    const { channels } = await sharp(result.png).stats();
    expect(result).toMatchObject({ width: 10, height: 10 });
    expect(channels.slice(0, 3).map((channel) => channel.mean)).toEqual([0, 255, 0]);
  });
});

describe('prepareUpload', () => {
  it.each(['jpeg', 'png', 'webp'] as const)(
    'turns a %s upload into a PNG, a thumbnail and a moderation copy',
    async (format) => {
      const result = await prepareUpload(await solidImage(format, 1600, 1200));

      expect(isPng(result.png)).toBe(true);
      expect(result).toMatchObject({ width: 1600, height: 1200 });
      expect(await sharp(result.thumbnail.webp).metadata()).toMatchObject({
        format: 'webp',
        width: THUMBNAIL_MAX_PX,
        height: 384,
      });
      expect(await sharp(result.moderationCopy).metadata()).toMatchObject({
        format: 'jpeg',
        width: MODERATION_COPY_PX,
        height: 768,
      });
    },
  );

  it('scales a large upload down to fit 4096 px', async () => {
    const result = await prepareUpload(await solidImage('jpeg', 5000, 2500));
    expect(result).toMatchObject({ width: UPLOAD_MAX_PX, height: 2048 });
  });

  it('turns a photo upright and drops its metadata', async () => {
    const jpeg = new Uint8Array(
      await sharp(await solidImage('jpeg', 300, 200))
        .withExif({ IFD0: { Copyright: 'Pictora test' } })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );
    const result = await prepareUpload(jpeg);
    expect(result).toMatchObject({ width: 200, height: 300 });
    const metadata = await sharp(result.png).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it.each([
    ['a PDF', new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')],
    ['random bytes', new Uint8Array(512).fill(7)],
  ])('refuses %s', async (_name, bytes) => {
    await expect(prepareUpload(bytes)).rejects.toBeInstanceOf(NotAnImageError);
  });

  it('refuses an image format other than JPEG, PNG or WebP', async () => {
    const gif = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
        .gif()
        .toBuffer(),
    );
    await expect(prepareUpload(gif)).rejects.toBeInstanceOf(NotAnImageError);
  });

  it('refuses a truncated image', async () => {
    const jpeg = await solidImage('jpeg', 400, 400);
    await expect(prepareUpload(jpeg.subarray(0, 200))).rejects.toBeInstanceOf(NotAnImageError);
  });
});
