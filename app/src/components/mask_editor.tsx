'use client';

import { EraserIcon, Undo2Icon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle_group';
import {
  BRUSH_SIZES,
  DEFAULT_BRUSH,
  MASK_DISPLAY_MAX_PX,
  brushPixels,
  drawStrokes,
  fitWithin,
  imagePoint,
  type BrushSizeId,
  type MaskStroke,
} from '../lib/mask';

/** The colour strokes are shown in over the picture; the uploaded mask is white on black. */
const STROKE_COLOUR = 'rgba(239, 68, 68, 0.55)';

export interface MaskEditorProps {
  /** The picture to draw on, and its size in pixels. */
  imageUrl: string;
  imageAlt: string;
  width: number;
  height: number;
  strokes: readonly MaskStroke[];
  onStrokesChange: (strokes: MaskStroke[]) => void;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/**
 * The erase tool's brush mask editor (tech design 5.5): the user paints over what to erase on a canvas laid over
 * the picture, with a choice of brush size, undo and clear. Strokes are kept in image pixels, so the mask fits
 * the image whatever its size on screen. A tap paints a dot, so the mask can be drawn without dragging.
 */
export function MaskEditor({
  imageUrl,
  imageAlt,
  width,
  height,
  strokes,
  onStrokesChange,
}: MaskEditorProps) {
  const id = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [brush, setBrush] = useState<BrushSizeId>(DEFAULT_BRUSH);
  const [drawing, setDrawing] = useState<MaskStroke>();
  const display = fitWithin({ width, height }, MASK_DISPLAY_MAX_PX);

  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, display.width, display.height);
    drawStrokes(context, drawing ? [...strokes, drawing] : strokes, display.scale, STROKE_COLOUR);
  }, [strokes, drawing, display.width, display.height, display.scale]);

  function pointOf(event: PointerEvent<HTMLCanvasElement>) {
    return imagePoint(event, event.currentTarget.getBoundingClientRect(), { width, height });
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrawing({ size: brushPixels(brush, { width, height }), points: [pointOf(event)] });
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    const point = pointOf(event);
    setDrawing({ ...drawing, points: [...drawing.points, point] });
  }

  function finish() {
    if (!drawing) return;
    onStrokesChange([...strokes, drawing]);
    setDrawing(undefined);
  }

  return (
    <div data-slot="mask-editor" className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-lg border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
        <img
          src={imageUrl}
          alt={imageAlt}
          width={width}
          height={height}
          draggable={false}
          className="h-auto max-h-[50svh] w-full object-contain select-none"
        />
        <canvas
          ref={canvas}
          width={display.width}
          height={display.height}
          role="img"
          aria-label={`Erase mask: ${plural(strokes.length, 'stroke')}. Paint over what to erase.`}
          data-strokes={strokes.length}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={finish}
          onPointerLeave={finish}
          className="absolute inset-0 size-full cursor-crosshair touch-none"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span id={`${id}-brush`} className="text-sm text-muted-foreground">
            Brush
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-labelledby={`${id}-brush`}
            value={brush}
            onValueChange={(value) => {
              if (value) setBrush(value as BrushSizeId);
            }}
          >
            {BRUSH_SIZES.map((size) => (
              <ToggleGroupItem key={size.id} value={size.id} aria-label={`${size.label} brush`}>
                {size.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={strokes.length === 0}
            onClick={() => onStrokesChange(strokes.slice(0, -1))}
          >
            <Undo2Icon aria-hidden="true" />
            Undo
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={strokes.length === 0}
            onClick={() => onStrokesChange([])}
          >
            <EraserIcon aria-hidden="true" />
            Clear
          </Button>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {plural(strokes.length, 'stroke')} painted
      </p>
    </div>
  );
}
