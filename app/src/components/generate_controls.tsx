'use client';

import {
  AUTO_MODEL_ID,
  MAX_AVOID_LENGTH,
  MAX_IMAGE_COUNT,
  MIN_IMAGE_COUNT,
  QUALITIES,
  type Aspect,
  type Quality,
  type StyleId,
} from '@pictora/core';
import {
  ChevronDownIcon,
  ClockIcon,
  EllipsisIcon,
  SlidersHorizontalIcon,
  SquareDashedIcon,
} from 'lucide-react';
import Image from 'next/image';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle_group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ASPECT_SHAPES, QUALITY_LABELS, modelCostSummary } from '../lib/generate_options';
import type { PublicModel, PublicStyle } from '../lib/models_response';
import { SAMPLE_IMAGES } from '../lib/sample_images';

const SAMPLE_BY_STYLE = new Map(SAMPLE_IMAGES.map((sample) => [sample.style, sample]));
const THUMBNAIL_SIZE = 72;

const COUNTS = Array.from(
  { length: MAX_IMAGE_COUNT - MIN_IMAGE_COUNT + 1 },
  (_, index) => MIN_IMAGE_COUNT + index,
);

/**
 * How a request's image count reads (GEN-6): one image, or that many variations, since each is a separate take
 * on the same prompt.
 */
export function variationsLabel(count: number): string {
  return count === 1 ? '1 image' : `${count} variations`;
}

/** A style's sample image, or "Aa" for None, which adds nothing to the prompt. */
function StyleThumbnail({ styleId, className }: { styleId: StyleId; className: string }) {
  const sample = styleId === 'none' ? undefined : SAMPLE_BY_STYLE.get(styleId);
  if (!sample) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md bg-muted font-semibold text-muted-foreground',
          className,
        )}
      >
        Aa
      </span>
    );
  }
  return (
    <Image
      src={sample.src}
      alt=""
      width={THUMBNAIL_SIZE}
      height={THUMBNAIL_SIZE}
      className={cn('shrink-0 rounded-md object-cover', className)}
      unoptimized
    />
  );
}

/** The style presets with their sample thumbnails, in a popover (GEN-4). */
export function StylePicker({
  styles,
  value,
  onChange,
}: {
  styles: readonly PublicStyle[];
  value: StyleId;
  onChange: (style: StyleId) => void;
}) {
  const name = styles.find((style) => style.id === value)?.name ?? value;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={`Style: ${name}`}>
          <StyleThumbnail styleId={value} className="size-5 rounded-sm text-[0.5rem]" />
          {name}
          <ChevronDownIcon aria-hidden="true" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))]">
        <p className="mb-2 text-sm font-medium">Style</p>
        <ToggleGroup
          type="single"
          aria-label="Style"
          spacing={2}
          value={value}
          onValueChange={(next) => next && onChange(next as StyleId)}
          className="grid w-full grid-cols-3 gap-2"
        >
          {styles.map((style) => (
            <ToggleGroupItem
              key={style.id}
              value={style.id}
              className="h-auto w-full flex-col gap-1 p-1.5 text-xs whitespace-normal data-[state=on]:ring-2 data-[state=on]:ring-primary"
            >
              <StyleThumbnail styleId={style.id} className="aspect-square h-auto w-full text-lg" />
              <span>{style.name}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PopoverContent>
    </Popover>
  );
}

function AspectIcon({ aspect }: { aspect: Aspect }) {
  return (
    <span
      aria-hidden="true"
      data-aspect-icon={aspect}
      className={cn('inline-block rounded-[2px] border-2 border-current', ASPECT_SHAPES[aspect])}
    />
  );
}

/** The aspect ratios the model (or, with Auto, any model) offers, each with its shape (GEN-3). */
export function AspectPicker({
  id,
  aspects,
  value,
  onChange,
}: {
  /** Set where a visible label names the select, as in the settings sheet. */
  id?: string;
  aspects: readonly Aspect[];
  value: Aspect;
  onChange: (aspect: Aspect) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as Aspect)}>
      <SelectTrigger id={id} size="sm" aria-label={id ? undefined : 'Aspect ratio'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {aspects.map((aspect) => (
          <SelectItem key={aspect} value={aspect}>
            <span className="flex size-4 items-center justify-center">
              <AspectIcon aspect={aspect} />
            </span>
            {aspect}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** What a quality costs per image, or why it can't be picked. */
export interface QualityOption {
  disabled: boolean;
  hint: string;
}

/** Draft, Standard and High, each with its points per image or the reason it is unavailable (GEN-6, LIM-2). */
export function QualityPicker({
  id,
  value,
  option,
  onChange,
}: {
  /** Set where a visible label names the select, as on the edit panel. */
  id?: string;
  value: Quality;
  option: (quality: Quality) => QualityOption;
  onChange: (quality: Quality) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as Quality)}>
      <SelectTrigger id={id} size="sm" aria-label={id ? undefined : 'Quality'}>
        <SelectValue>{QUALITY_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {QUALITIES.map((quality) => {
          const { disabled, hint } = option(quality);
          return (
            <SelectItem key={quality} value={quality} disabled={disabled}>
              {QUALITY_LABELS[quality]}
              <span className="text-xs text-muted-foreground">{hint}</span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * One image, or two to four variations of the same prompt, each with what the request would cost (GEN-6). Every
 * variation is a separate take that costs full points, so the points are shown next to each choice.
 */
export function VariationsPicker({
  id,
  value,
  cost,
  onChange,
}: {
  /** Set where a visible label names the select, as in the settings sheet. */
  id?: string;
  value: number;
  /** The points a request of this many images would use. */
  cost: (count: number) => number;
  onChange: (count: number) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger id={id} size="sm" aria-label={id ? undefined : 'Variations'}>
        <SelectValue>{variationsLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {COUNTS.map((count) => {
          const points = cost(count);
          return (
            <SelectItem key={count} value={String(count)}>
              {variationsLabel(count)}
              <span className="text-xs text-muted-foreground">
                {points} {points === 1 ? 'point' : 'points'}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** A setting the More options offer, where the model (or, with Auto, any model) supports it. */
export interface ExtraOption<T> {
  value: T;
  onChange: (value: T) => void;
}

export interface ExtraOptionsProps {
  /** Transparent background (GEN-9). */
  transparent?: ExtraOption<boolean>;
  /** "Save points: deliver later", a batch job at half the points (tech design 5.4). */
  later?: ExtraOption<boolean>;
  /** The negative prompt (GEN-2). */
  avoid?: ExtraOption<string>;
}

/** Whether any of the More options is offered. */
export function hasExtraOptions({ transparent, later, avoid }: ExtraOptionsProps): boolean {
  return transparent !== undefined || later !== undefined || avoid !== undefined;
}

/** How many of the More options are switched on or filled in, shown on the More button. */
function extrasInUse({ transparent, later, avoid }: ExtraOptionsProps): number {
  return [transparent?.value, later?.value, avoid && avoid.value.trim() !== ''].filter(Boolean)
    .length;
}

/**
 * The less common settings: transparent background, saving points by delivering later, and things to avoid. They
 * sit behind More in the composer's settings row, and inline in the settings sheet on small screens.
 */
export function ExtraOptions({ transparent, later, avoid }: ExtraOptionsProps) {
  const avoidId = useId();
  const laterHintId = useId();
  return (
    <div className="flex flex-col gap-3">
      {(transparent || later) && (
        <div className="flex flex-wrap gap-2">
          {transparent && (
            <Toggle
              variant="outline"
              size="sm"
              aria-label="Transparent background"
              pressed={transparent.value}
              onPressedChange={transparent.onChange}
            >
              <SquareDashedIcon aria-hidden="true" />
              Transparent background
            </Toggle>
          )}
          {later && (
            <Toggle
              variant="outline"
              size="sm"
              aria-label="Save points: deliver later"
              aria-describedby={laterHintId}
              pressed={later.value}
              onPressedChange={later.onChange}
            >
              <ClockIcon aria-hidden="true" />
              Save points
            </Toggle>
          )}
        </div>
      )}
      {later && (
        <p id={laterHintId} className="text-xs text-muted-foreground">
          Half the points. Your images arrive in your gallery within 24 hours, often much sooner.
          The points stay reserved until then, and come back if the images don&apos;t.
        </p>
      )}
      {avoid && (
        <div className="grid gap-1.5">
          <Label htmlFor={avoidId}>Avoid (optional)</Label>
          <Input
            id={avoidId}
            type="text"
            maxLength={MAX_AVOID_LENGTH}
            value={avoid.value}
            placeholder="Things to leave out, for example text or blur"
            onChange={(event) => avoid.onChange(event.target.value)}
          />
        </div>
      )}
    </div>
  );
}

/** The More button in the composer's settings row, with the extra options in a popover. */
export function MorePicker(props: ExtraOptionsProps) {
  const inUse = extrasInUse(props);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={inUse > 0 ? 'secondary' : 'outline'}
          size="sm"
          aria-label={inUse > 0 ? `More options, ${inUse} on` : 'More options'}
        >
          <EllipsisIcon aria-hidden="true" />
          More
          {inUse > 0 && <span className="text-xs text-muted-foreground">{inUse}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))]">
        <ExtraOptions {...props} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Auto and every available model, with its strengths and costs (GEN-5). The button names the model, or with
 * Auto the model it picks, and a tooltip explains why Auto picked it.
 */
export function ModelPicker({
  models,
  auto,
  modelId,
  modelName,
  autoReason,
  onAuto,
  onModel,
}: {
  models: readonly PublicModel[];
  auto: boolean;
  modelId: string;
  /** The chosen model's name, or with Auto the one it picks. */
  modelName: string;
  /** Why Auto picked the model, as a sentence; read out with the button. */
  autoReason?: string;
  onAuto: () => void;
  onModel: (model: PublicModel) => void;
}) {
  const reasonId = useId();
  const shown = auto ? `Auto · ${modelName}` : modelName;
  function choose(next: string) {
    if (next === AUTO_MODEL_ID) onAuto();
    const model = models.find((candidate) => candidate.id === next);
    if (model) onModel(model);
  }

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Model: ${shown}`}
      aria-describedby={auto && autoReason ? reasonId : undefined}
      className="max-w-full min-w-0"
    >
      <SlidersHorizontalIcon aria-hidden="true" />
      <span className="truncate">{shown}</span>
    </Button>
  );

  return (
    <Popover>
      {auto && autoReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{autoReason}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      {auto && autoReason && (
        <span id={reasonId} className="sr-only" aria-live="polite">
          {autoReason}
        </span>
      )}
      <PopoverContent
        align="end"
        className="max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto"
      >
        <p className="mb-2 text-sm font-medium">Model</p>
        <ToggleGroup
          type="single"
          orientation="vertical"
          aria-label="Model"
          spacing={1}
          value={auto ? AUTO_MODEL_ID : modelId}
          onValueChange={(next) => next && choose(next)}
          className="flex w-full flex-col items-stretch gap-1"
        >
          <ModelOption
            value={AUTO_MODEL_ID}
            name="Auto (recommended)"
            hints={['Picks a model for your style, quality, prompt and points left']}
          />
          {models.map((model) => (
            <ModelOption
              key={model.id}
              value={model.id}
              name={model.displayName}
              hints={[model.strengths.join(', '), modelCostSummary(model)]}
            />
          ))}
        </ToggleGroup>
      </PopoverContent>
    </Popover>
  );
}

function ModelOption({ value, name, hints }: { value: string; name: string; hints: string[] }) {
  return (
    <ToggleGroupItem
      value={value}
      className="h-auto w-full flex-col items-start gap-0.5 px-3 py-2 text-left whitespace-normal data-[state=on]:ring-2 data-[state=on]:ring-primary"
    >
      <span className="font-medium">{name}</span>
      {hints.map((hint) => (
        <span key={hint} className="text-xs font-normal text-muted-foreground">
          {hint}
        </span>
      ))}
    </ToggleGroupItem>
  );
}
