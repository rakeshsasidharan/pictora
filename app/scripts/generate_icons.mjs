// Generates the app icons from the source artwork (#117). Run with `npm run icons --workspace @pictora/app`
// after replacing `assets/pictora_icon_source.png`, then commit the generated files.
//
// The source is 1024×1024 with its "transparent" background painted in as a grey and white checkerboard, and a
// rounded dark square in the middle. Every icon starts from a full-bleed crop taken from inside that square, so
// none of the checkerboard or the original rounded frame survives:
// - favicon.ico, icon.png and the manifest's "any" icons get our own rounded corners with real transparency
// - apple-icon.png is full-bleed and opaque, since iOS draws its own rounded mask
// - the maskable manifest icon keeps the "P" inside the central safe zone that Android masks may crop to
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(APP_DIR, 'assets', 'pictora_icon_source.png');

/** The full-bleed crop: inside the source's rounded square, clear of its rim and the checkerboard. */
export const CROP = { left: 140, top: 132, width: 744, height: 744 };

/** Corner radius of the rounded icons, as a share of the side (close to the iOS shape). */
const CORNER_RATIO = 0.225;

/** The maskable icon's artwork fills this share of the side, inside Android's 80% safe zone. */
const MASKABLE_ART_RATIO = 0.72;

/**
 * Full-colour PNG. The artwork's gradients band or turn grainy with a 256-colour palette, and adaptive
 * filtering keeps full colour small (about 15 KB at 180 px).
 */
const PNG_OPTIONS = { compressionLevel: 9, adaptiveFiltering: true, effort: 10 };

/** Files to write, relative to `app/`, with how to make each one. */
export const ICONS = [
  // Linked from every page, so kept small; the manifest has the 512 px version.
  { file: 'src/app/icon.png', size: 192, kind: 'rounded' },
  { file: 'src/app/apple-icon.png', size: 180, kind: 'full-bleed' },
  { file: 'public/icons/icon_192.png', size: 192, kind: 'rounded' },
  { file: 'public/icons/icon_512.png', size: 512, kind: 'rounded' },
  { file: 'public/icons/icon_maskable_512.png', size: 512, kind: 'maskable' },
];

/** The favicon's sizes, one PNG image each inside the ICO file. */
export const FAVICON = { file: 'src/app/favicon.ico', sizes: [16, 32, 48] };

function fullBleed(size) {
  return sharp(SOURCE).extract(CROP).resize(size, size, { kernel: 'lanczos3' }).png();
}

/** A rounded-rectangle mask with real transparency outside the corners. */
function roundedMask(size) {
  const radius = Math.round(size * CORNER_RATIO);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );
}

async function rounded(size) {
  const art = await fullBleed(size).toBuffer();
  return sharp(art)
    .ensureAlpha()
    .composite([{ input: roundedMask(size), blend: 'dest-in' }])
    .png(PNG_OPTIONS)
    .toBuffer();
}

/** The average colour of the crop's outer band: the dark navy the art sits on. */
async function edgeColour() {
  const band = 24;
  const { data, info } = await sharp(SOURCE)
    .extract(CROP)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const totals = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const inBand = x < band || y < band || x >= info.width - band || y >= info.height - band;
      if (!inBand) continue;
      const index = (y * info.width + x) * info.channels;
      for (let channel = 0; channel < 3; channel++) totals[channel] += data[index + channel];
      count++;
    }
  }
  const [r, g, b] = totals.map((total) => Math.round(total / count));
  return { r, g, b };
}

/**
 * The art scaled into the middle of a plain background in the art's own edge colour, so a circle or squircle
 * mask never cuts into the "P". The art's edges are feathered into the background so no seam shows.
 */
async function maskable(size) {
  const background = await sharp({
    create: { width: size, height: size, channels: 3, background: await edgeColour() },
  })
    .png()
    .toBuffer();
  const artSize = Math.round(size * MASKABLE_ART_RATIO);
  const feather = Math.round(artSize * 0.08);
  const featherMask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${artSize}" height="${artSize}">` +
      `<defs><filter id="f"><feGaussianBlur stdDeviation="${feather / 2}"/></filter></defs>` +
      `<rect x="${feather}" y="${feather}" width="${artSize - 2 * feather}" height="${artSize - 2 * feather}" ` +
      `rx="${feather * 2}" fill="#fff" filter="url(#f)"/></svg>`,
  );
  const art = await sharp(await fullBleed(artSize).toBuffer())
    .ensureAlpha()
    .composite([{ input: featherMask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const offset = Math.round((size - artSize) / 2);
  return sharp(background)
    .composite([{ input: art, left: offset, top: offset }])
    .removeAlpha()
    .png(PNG_OPTIONS)
    .toBuffer();
}

async function opaque(size) {
  return fullBleed(size).removeAlpha().png(PNG_OPTIONS).toBuffer();
}

/** An ICO file holding one PNG image per size (PNG-in-ICO, supported by every current browser). */
export function icoFromPngs(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

async function write(file, data) {
  const path = join(APP_DIR, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  console.log(`${file}: ${(data.length / 1024).toFixed(1)} KB`);
}

async function main() {
  for (const { file, size, kind } of ICONS) {
    const make = { rounded, 'full-bleed': opaque, maskable }[kind];
    await write(file, await make(size));
  }
  const favicons = await Promise.all(
    FAVICON.sizes.map(async (size) => ({ size, png: await rounded(size) })),
  );
  await write(FAVICON.file, icoFromPngs(favicons));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
