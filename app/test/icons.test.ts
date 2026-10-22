import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import manifest, { BRAND_BACKGROUND } from '../src/app/manifest';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function pixel(input: string | Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const index = (y * info.width + x) * 4;
  return [...data.subarray(index, index + 4)];
}

const luminance = ([r = 0, g = 0, b = 0]: number[]) => (r + g + b) / 3;

/** A rounded icon: transparent in the corners, opaque in the middle. */
async function expectRounded(input: string | Buffer, size: number) {
  const meta = await sharp(input).metadata();
  expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(['png', size, size, true]);
  expect((await pixel(input, 0, 0))[3]).toBe(0);
  expect((await pixel(input, size - 1, size - 1))[3]).toBe(0);
  expect((await pixel(input, Math.floor(size / 2), Math.floor(size / 2)))[3]).toBe(255);
}

/**
 * A full-bleed icon: opaque to the edges, with a dark corner. The source artwork has a light grey checkerboard
 * painted around its rounded frame, so a light corner means it leaked into the crop.
 */
async function expectFullBleed(input: string, size: number) {
  const meta = await sharp(input).metadata();
  expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(['png', size, size, false]);
  for (const [x, y] of [
    [0, 0],
    [size - 1, 0],
    [0, size - 1],
    [size - 1, size - 1],
  ] as const) {
    expect(luminance(await pixel(input, x, y))).toBeLessThan(80);
  }
}

async function expectUnder(path: string, kilobytes: number) {
  expect((await stat(path)).size).toBeLessThan(kilobytes * 1024);
}

const app = (file: string) => join(APP_DIR, file);

describe('app icons', () => {
  it('icon.png is a small rounded 192 px icon with real transparency', async () => {
    await expectRounded(app('src/app/icon.png'), 192);
    await expectUnder(app('src/app/icon.png'), 40);
  });

  it('apple-icon.png is a full-bleed 180 px icon, since iOS draws its own rounded mask', async () => {
    await expectFullBleed(app('src/app/apple-icon.png'), 180);
    await expectUnder(app('src/app/apple-icon.png'), 40);
  });

  it('favicon.ico holds rounded 16, 32 and 48 px PNGs', async () => {
    const ico = await readFile(app('src/app/favicon.ico'));
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16;
      const size = ico.readUInt8(entry);
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const png = ico.subarray(offset, offset + length);
      expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      await expectRounded(png, size);
      sizes.push(size);
    }
    expect(sizes).toEqual([16, 32, 48]);
    await expectUnder(app('src/app/favicon.ico'), 20);
  });

  it('the manifest icons are rounded at 192 and 512 px, plus a full-bleed maskable one', async () => {
    await expectRounded(app('public/icons/icon_192.png'), 192);
    await expectRounded(app('public/icons/icon_512.png'), 512);
    await expectFullBleed(app('public/icons/icon_maskable_512.png'), 512);
    await expectUnder(app('public/icons/icon_192.png'), 40);
    await expectUnder(app('public/icons/icon_512.png'), 200);
    await expectUnder(app('public/icons/icon_maskable_512.png'), 200);
  });

  it('serves only the generated icons, never the 1 MB source artwork', async () => {
    expect((await readdir(app('public/icons'))).sort()).toEqual([
      'icon_192.png',
      'icon_512.png',
      'icon_maskable_512.png',
    ]);
  });
});

describe('web app manifest', () => {
  const body = manifest();

  it('names the app and starts at the home page, in the icon background colour', () => {
    expect(body).toMatchObject({
      name: 'Pictora',
      short_name: 'Pictora',
      start_url: '/',
      display: 'standalone',
      background_color: BRAND_BACKGROUND,
      theme_color: BRAND_BACKGROUND,
    });
    expect(body.description).toMatch(/Turn text prompts into images/);
  });

  it('lists icons that exist at the sizes it claims', async () => {
    expect(body.icons?.map((icon) => icon.purpose)).toEqual(['any', 'any', 'maskable']);
    for (const icon of body.icons ?? []) {
      const meta = await sharp(app(`public${icon.src}`)).metadata();
      expect(`${meta.width}x${meta.height}`).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
  });

  it('uses the maskable icon background as its brand colour', async () => {
    const [r = 0, g = 0, b = 0] = await pixel(app('public/icons/icon_maskable_512.png'), 2, 2);
    const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    expect(hex).toBe(BRAND_BACKGROUND);
  });
});
