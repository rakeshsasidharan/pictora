/** A point on the image, in the image's own pixels. */
export interface MaskPoint {
  x: number;
  y: number;
}

/** One brush stroke of the erase mask (tech design 5.5): its width in image pixels and the points it passes. */
export interface MaskStroke {
  size: number;
  points: MaskPoint[];
}

/** Brush sizes the mask editor offers, as a share of the image's longer side. */
export const BRUSH_SIZES = [
  { id: 'small', label: 'Small', share: 0.02 },
  { id: 'medium', label: 'Medium', share: 0.05 },
  { id: 'large', label: 'Large', share: 0.1 },
] as const;
export type BrushSizeId = (typeof BRUSH_SIZES)[number]['id'];
export const DEFAULT_BRUSH: BrushSizeId = 'medium';

/** The brush width in image pixels for a size on an image, at least 2 px. */
export function brushPixels(size: BrushSizeId, image: { width: number; height: number }): number {
  const share = BRUSH_SIZES.find((option) => option.id === size)?.share ?? 0.05;
  return Math.max(2, Math.round(Math.max(image.width, image.height) * share));
}

/** The editor's canvas is drawn at most this wide or tall; it is scaled to the picture on screen. */
export const MASK_DISPLAY_MAX_PX = 1024;
/** The mask is uploaded at most this wide or tall; the worker resizes it to the image. */
export const MASK_UPLOAD_MAX_PX = 2048;

/** A size scaled down (never up) to fit `max` on its longer side, keeping the shape. */
export function fitWithin(size: { width: number; height: number }, max: number) {
  const scale = Math.min(1, max / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    scale,
  };
}

/** Where a pointer is on the image, in image pixels, from its position on the element showing it. */
export function imagePoint(
  client: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  image: { width: number; height: number },
): MaskPoint {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const x = rect.width > 0 ? ((client.clientX - rect.left) / rect.width) * image.width : 0;
  const y = rect.height > 0 ? ((client.clientY - rect.top) / rect.height) * image.height : 0;
  return { x: clamp(x, image.width), y: clamp(y, image.height) };
}

/** The 2D drawing calls the mask needs, so the drawing can be tested without a real canvas. */
export type MaskContext = Pick<
  CanvasRenderingContext2D,
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'arc'
  | 'fill'
  | 'fillRect'
  | 'clearRect'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
>;

/**
 * Draws the strokes on a context `scale` times the image's size: round-capped lines, and a dot for a stroke of
 * one point (a tap, so the mask can be drawn without dragging).
 */
export function drawStrokes(
  context: MaskContext,
  strokes: readonly MaskStroke[],
  scale: number,
  colour: string,
): void {
  context.strokeStyle = colour;
  context.fillStyle = colour;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    const [first, ...rest] = stroke.points;
    if (!first) continue;
    const width = stroke.size * scale;
    if (rest.length === 0) {
      context.beginPath();
      context.arc(first.x * scale, first.y * scale, width / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(first.x * scale, first.y * scale);
    for (const point of rest) context.lineTo(point.x * scale, point.y * scale);
    context.stroke();
  }
}

/**
 * The erase mask as a PNG: white strokes on black, at the image's shape and at most 2048 px, which the worker
 * resizes to the image (white is erased, black kept).
 */
export async function renderMaskPng(
  strokes: readonly MaskStroke[],
  image: { width: number; height: number },
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
): Promise<Blob> {
  const { width, height, scale } = fitWithin(image, MASK_UPLOAD_MAX_PX);
  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available');
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  drawStrokes(context, strokes, scale, '#ffffff');
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The mask could not be saved'))),
      'image/png',
    );
  });
}
