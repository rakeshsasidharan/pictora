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
import { BanIcon, ChevronDownIcon, SlidersHorizontalIcon } from 'lucide-react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle_group';
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
  aspects,
  value,
  onChange,
}: {
  aspects: readonly Aspect[];
  value: Aspect;
  onChange: (aspect: Aspect) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as Aspect)}>
      <SelectTrigger size="sm" aria-label="Aspect ratio">
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
  value,
  option,
  onChange,
}: {
  value: Quality;
  option: (quality: Quality) => QualityOption;
  onChange: (quality: Quality) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as Quality)}>
      <SelectTrigger size="sm" aria-label="Quality">
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

/** One to four images per request (GEN-9). */
export function CountPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (count: number) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label="Number of images"
      value={String(value)}
      onValueChange={(next) => next && onChange(Number(next))}
    >
      {COUNTS.map((count) => (
        <ToggleGroupItem
          key={count}
          value={String(count)}
          aria-label={`${count} ${count === 1 ? 'image' : 'images'}`}
        >
          {count}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** The negative prompt, for models that take one (GEN-2). */
export function AvoidPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (avoid: string) => void;
}) {
  const set = value.trim() !== '';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={set ? 'secondary' : 'outline'}
          size="sm"
          aria-label={set ? `Avoid: ${value.trim()}` : 'Avoid'}
        >
          <BanIcon aria-hidden="true" />
          Avoid
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-[min(20rem,calc(100vw-2rem))] gap-2">
        <label htmlFor="avoid" className="text-sm font-medium">
          Avoid (optional)
        </label>
        <Input
          id="avoid"
          type="text"
          maxLength={MAX_AVOID_LENGTH}
          value={value}
          placeholder="Things to leave out, for example text or blur"
          onChange={(event) => onChange(event.target.value)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Auto and every available model, with its strengths and costs, behind "Advanced" (GEN-5). */
export function ModelPicker({
  models,
  auto,
  modelId,
  onAuto,
  onModel,
}: {
  models: readonly PublicModel[];
  auto: boolean;
  modelId: string;
  onAuto: () => void;
  onModel: (model: PublicModel) => void;
}) {
  function choose(next: string) {
    if (next === AUTO_MODEL_ID) onAuto();
    const model = models.find((candidate) => candidate.id === next);
    if (model) onModel(model);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="Advanced">
          <SlidersHorizontalIcon aria-hidden="true" />
          <span className="hidden sm:inline">Advanced</span>
        </Button>
      </PopoverTrigger>
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
