import { createHash } from 'node:crypto';
import {
  mapAspect,
  MAX_IMAGE_COUNT,
  MIN_IMAGE_COUNT,
  TOOL_NAMES,
  toolCostPoints,
  type ModelConfig,
  type Size,
} from '@pictora/core';
import sharp, { type Sharp } from 'sharp';
import { ProviderError, ProviderSafetyError, ProviderTimeoutError } from './errors.js';
import { sleep } from './retry.js';
import {
  BATCH_PRICE_FACTOR,
  type BatchImageProvider,
  type BatchItem,
  type BatchItemResult,
  type BatchPoll,
  type GeneratedImage,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
  type ToolRequest,
} from './types.js';

/** Prompt keywords that make the mock fail on purpose, for tests. */
export const MOCK_FAIL_KEYWORD = '__fail__';
export const MOCK_BLOCK_KEYWORD = '__block__';
export const MOCK_TIMEOUT_KEYWORD = '__timeout__';

/** Batch IDs the mock hands out start with this. */
export const MOCK_BATCH_PREFIX = 'mock-batch-';

/** The mock upscales double each side, up to this many pixels, so test images stay small. */
export const MOCK_UPSCALE_MAX_PX = 4096;

/** Default delay before the mock answers; `MOCK_PROVIDER_DELAY_MS` overrides it. */
export const MOCK_DEFAULT_DELAY_MS = 1_000;

const MAX_PROMPT_CHARS_SHOWN = 300;

export interface MockProviderOptions {
  /** How long each call takes, in ms. */
  delayMs?: number;
}

/**
 * A provider that needs no network or spend, for dev, CI and end-to-end tests (tech design 6.2).
 * It returns placeholder PNGs at the model's mapped size showing the prompt, after a delay. Prompts with
 * `__fail__`, `__block__` or `__timeout__` raise the matching typed error. Its cost is the model's list
 * price, so points behave as they would with a real provider.
 */
export class MockProvider implements ImageProvider, BatchImageProvider {
  readonly delayMs: number;

  constructor(options: MockProviderOptions = {}) {
    this.delayMs = options.delayMs ?? delayFromEnv() ?? MOCK_DEFAULT_DELAY_MS;
  }

  generate(model: ModelConfig, req: ImageRequest): Promise<ImageResult> {
    return this.run(model, req, 'generate');
  }

  edit(model: ModelConfig, req: ImageRequest): Promise<ImageResult> {
    if (!req.inputImage) {
      return Promise.reject(new ProviderError(`Model ${model.id}: an edit needs an input image`));
    }
    return this.run(model, req, 'edit');
  }

  /**
   * Runs an image tool without a provider (P1 Image tools), after the delay: an upscale doubles each side,
   * remove background keeps an ellipse in the middle and makes the rest transparent, erase greys out the white
   * of the mask, and outpaint extends the canvas by the sides asked for. The tool's name is written on the
   * result. A prompt with `__fail__`, `__block__` or `__timeout__` raises the matching error.
   */
  async tool(model: ModelConfig, req: ToolRequest): Promise<ImageResult> {
    const costPoints = toolCostPoints(model, req.tool);
    if (costPoints === undefined)
      throw new ProviderError(`Model ${model.id} does not run ${req.tool}`);
    await sleep(this.delayMs, req.signal);
    raiseForKeywords(req.prompt ?? '');
    const png = await mockToolImage(req);
    const meta = await sharp(png).metadata();
    return {
      images: [{ png, width: meta.width, height: meta.height }],
      providerRequestId: `mock-tool-${createHash('sha256').update(png).digest('hex').slice(0, 16)}`,
      providerCostCents: costPoints,
    };
  }

  /**
   * Accepts any batch straight away (tech design 5.4). The ID is a hash of the job IDs, since the mock keeps no
   * state: the poller sends the jobs back when it reads the batch.
   */
  submitBatch(model: ModelConfig, items: readonly BatchItem[]): Promise<string> {
    if (!model.capabilities.generate || !model.capabilities.batch) {
      return Promise.reject(new ProviderError(`Model ${model.id} does not take batch jobs`));
    }
    if (items.length === 0)
      return Promise.reject(new ProviderError('A batch needs at least one job'));
    const hash = createHash('sha256')
      .update(items.map((item) => item.key).join(','))
      .digest('hex')
      .slice(0, 16);
    return Promise.resolve(`${MOCK_BATCH_PREFIX}${hash}`);
  }

  /**
   * A mock batch is done the first time it is read: each job gets its placeholder images at batch price, or
   * the typed error its prompt asks for (`__block__`, `__fail__`, `__timeout__`).
   */
  async pollBatch(
    model: ModelConfig,
    batchId: string,
    items: readonly BatchItem[],
    signal: AbortSignal,
  ): Promise<BatchPoll> {
    if (!batchId.startsWith(MOCK_BATCH_PREFIX)) {
      return { state: 'failed', error: new ProviderError(`Unknown mock batch ${batchId}`) };
    }
    const results = new Map<string, BatchItemResult>();
    for (const item of items) {
      try {
        const result = await this.run(model, { ...item.request, signal }, 'generate', 0);
        results.set(item.key, {
          images: result.images,
          providerCostCents: result.providerCostCents * BATCH_PRICE_FACTOR,
        });
      } catch (error) {
        results.set(item.key, { images: [], providerCostCents: 0, error: error as Error });
      }
    }
    return { state: 'done', expired: false, results };
  }

  private async run(
    model: ModelConfig,
    req: ImageRequest,
    mode: 'generate' | 'edit',
    delayMs = this.delayMs,
  ): Promise<ImageResult> {
    if (!model.capabilities[mode]) {
      throw new ProviderError(`Model ${model.id} does not support ${mode}`);
    }
    if (
      !Number.isInteger(req.count) ||
      req.count < MIN_IMAGE_COUNT ||
      req.count > MAX_IMAGE_COUNT
    ) {
      throw new ProviderError(
        `Image count must be ${MIN_IMAGE_COUNT}–${MAX_IMAGE_COUNT}: ${req.count}`,
      );
    }
    const quality = model.qualities[req.quality];
    if (!quality) throw new ProviderError(`Model ${model.id} has no ${req.quality} quality`);
    const size = mapAspect(model, req.aspect, req.quality).output;

    await sleep(delayMs, req.signal);
    raiseForKeywords(req.prompt);

    const baseSeed = req.seed ?? seedFromPrompt(req.prompt);
    const images: GeneratedImage[] = [];
    for (let index = 0; index < req.count; index++) {
      const seed = (baseSeed + index) % 2 ** 32;
      const png = await placeholderPng(size, {
        title: mode === 'edit' ? 'Mock edit' : 'Mock image',
        text: req.prompt,
        caption: `${model.id} · ${req.aspect} · ${req.quality} · ${index + 1}/${req.count} · seed ${seed}`,
        seed,
        background: mode === 'edit' ? req.inputImage : undefined,
      });
      images.push({ png, width: size.width, height: size.height, seed });
    }
    return {
      images,
      providerRequestId: `mock-${createHash('sha256').update(`${req.prompt}:${baseSeed}`).digest('hex').slice(0, 16)}`,
      providerCostCents: quality.costPoints * req.count,
    };
  }
}

/** Raises the typed error a test prompt asks for. */
function raiseForKeywords(prompt: string): void {
  if (prompt.includes(MOCK_BLOCK_KEYWORD)) {
    throw new ProviderSafetyError(`Mock safety refusal (${MOCK_BLOCK_KEYWORD})`);
  }
  if (prompt.includes(MOCK_TIMEOUT_KEYWORD)) {
    throw new ProviderTimeoutError(`Mock timeout (${MOCK_TIMEOUT_KEYWORD})`);
  }
  if (prompt.includes(MOCK_FAIL_KEYWORD)) {
    throw new ProviderError(`Mock failure (${MOCK_FAIL_KEYWORD})`);
  }
}

/** What the mock makes for a tool, as a PNG. */
async function mockToolImage(req: ToolRequest): Promise<Uint8Array> {
  const meta = await sharp(req.image).metadata();
  const width = meta.width;
  const height = meta.height;
  const label = (w: number, h: number) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="${Math.round(w * 0.05)}" y="${Math.round(h * 0.1)}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${Math.max(12, Math.round(Math.min(w, h) / 20))}" font-weight="bold" fill="white">${escapeXml(`Mock ${TOOL_NAMES[req.tool]}`)}</text></svg>`,
    );
  let image: Sharp;
  switch (req.tool) {
    case 'upscale-fast':
    case 'upscale-conservative':
    case 'upscale-creative': {
      const scale = Math.min(2, MOCK_UPSCALE_MAX_PX / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const resized = await sharp(req.image).resize(w, h, { fit: 'fill' }).png().toBuffer();
      image = sharp(resized).composite([{ input: label(w, h) }]);
      break;
    }
    case 'remove-background': {
      const ellipse = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 3}" ry="${height / 3}" fill="white"/></svg>`,
      );
      image = sharp(req.image)
        .ensureAlpha()
        .composite([{ input: ellipse, blend: 'dest-in' }]);
      break;
    }
    case 'erase': {
      if (!req.mask) throw new ProviderError('Erase needs a mask');
      // The mask's white becomes a grey patch: grey where the mask is white, transparent elsewhere.
      const alpha = await sharp(req.mask)
        .resize(width, height, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer();
      const patch = await sharp({
        create: { width, height, channels: 3, background: '#808080' },
      })
        .joinChannel(alpha, { raw: { width, height, channels: 1 } })
        .png()
        .toBuffer();
      image = sharp(req.image).composite([{ input: patch }, { input: label(width, height) }]);
      break;
    }
    case 'outpaint': {
      const sides = req.outpaint ?? { left: 0, right: 0, up: 0, down: 0 };
      const extended = await sharp(req.image)
        .extend({
          left: sides.left,
          right: sides.right,
          top: sides.up,
          bottom: sides.down,
          background: '#4b5563',
        })
        .png()
        .toBuffer();
      const w = width + sides.left + sides.right;
      const h = height + sides.up + sides.down;
      image = sharp(extended).composite([{ input: label(w, h) }]);
      break;
    }
  }
  return new Uint8Array(await image.png().toBuffer());
}

function delayFromEnv(): number | undefined {
  const value = process.env.MOCK_PROVIDER_DELAY_MS;
  if (value === undefined || value === '') return undefined;
  const delay = Number(value);
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

function seedFromPrompt(prompt: string): number {
  return createHash('sha256').update(prompt).digest().readUInt32BE(0);
}

interface Placeholder {
  title: string;
  text: string;
  caption: string;
  seed: number;
  /** The image being edited, shown behind the text. */
  background?: Uint8Array;
}

/** Renders a PNG of the given size with a seed-coloured gradient (or the edited image) and the text. */
async function placeholderPng(size: Size, placeholder: Placeholder): Promise<Uint8Array> {
  const { width, height } = size;
  const hue = placeholder.seed % 360;
  const fontSize = Math.max(16, Math.round(Math.min(width, height) / 22));
  const charsPerLine = Math.max(10, Math.floor((width * 0.84) / (fontSize * 0.55)));
  const shown =
    placeholder.text.length > MAX_PROMPT_CHARS_SHOWN
      ? `${placeholder.text.slice(0, MAX_PROMPT_CHARS_SHOWN)}…`
      : placeholder.text;
  const lines = wrap(shown, charsPerLine);
  const lineHeight = Math.round(fontSize * 1.3);
  const top = Math.round(height / 2 - (lines.length * lineHeight) / 2);
  const x = Math.round(width * 0.08);

  const text = lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${top + index * lineHeight}" font-size="${fontSize}">${escapeXml(line)}</text>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue},55%,35%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,20%)"/>
  </linearGradient></defs>
  ${placeholder.background ? `<rect width="100%" height="100%" fill="black" fill-opacity="0.45"/>` : `<rect width="100%" height="100%" fill="url(#g)"/>`}
  <g font-family="DejaVu Sans, Helvetica, Arial, sans-serif" fill="white">
    <text x="${x}" y="${Math.round(height * 0.1)}" font-size="${Math.round(fontSize * 1.2)}" font-weight="bold">${escapeXml(placeholder.title)}</text>
    ${text}
    <text x="${x}" y="${Math.round(height * 0.93)}" font-size="${Math.round(fontSize * 0.7)}" fill-opacity="0.8">${escapeXml(placeholder.caption)}</text>
  </g>
</svg>`;

  const overlay = Buffer.from(svg);
  const image = placeholder.background
    ? sharp(placeholder.background)
        .resize(width, height, { fit: 'cover' })
        .composite([{ input: overlay }])
    : sharp(overlay);
  return new Uint8Array(await image.png().toBuffer());
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let start = 0; start < word.length; start += width) {
      const piece = word.slice(start, start + width);
      if (line && line.length + 1 + piece.length > width) {
        lines.push(line);
        line = piece;
      } else {
        line = line ? `${line} ${piece}` : piece;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);
}
