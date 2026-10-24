'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { versionAltText } from '../lib/edit_options';
import type { ImageVersionBody } from '../lib/images';

export interface VersionCarouselProps {
  versions: readonly ImageVersionBody[];
  /** The version shown above the carousel. */
  selected: number;
  onSelect: (version: number) => void;
  /** A thumbnail failed to load, for example because its presigned URL expired. */
  onImageError?: () => void;
}

/**
 * The image's versions as one row of thumbnails under the picture (#125), so any number of versions, with
 * prompts of any length, fits without pushing the page down. The row scrolls on its own; the previous and next
 * buttons step through the versions and keep the selected one in view. Hovering a thumbnail shows its prompt or
 * edit instruction.
 */
export function VersionCarousel({
  versions,
  selected,
  onSelect,
  onImageError,
}: VersionCarouselProps) {
  const index = versions.findIndex((version) => version.version === selected);
  const previous = index > 0 ? versions[index - 1] : undefined;
  const next = index >= 0 ? versions[index + 1] : undefined;
  const selectedButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Scrolls the row only, never the page, to bring the selected thumbnail into view.
    selectedButton.current?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    });
  }, [selected]);

  return (
    <div
      data-slot="version-carousel"
      role="group"
      aria-label="Version picker"
      className="flex items-center gap-2"
    >
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Previous version"
        disabled={!previous}
        onClick={() => previous && onSelect(previous.version)}
      >
        <ChevronLeftIcon />
      </Button>
      <ol
        aria-label="Versions"
        className="flex min-w-0 flex-1 snap-x snap-mandatory list-none gap-2 overflow-x-auto p-1"
      >
        {versions.map((version) => {
          const isSelected = version.version === selected;
          return (
            <li key={version.version} className="shrink-0 snap-start">
              <button
                ref={isSelected ? selectedButton : undefined}
                type="button"
                aria-pressed={isSelected}
                aria-label={`Version ${version.version}`}
                title={versionAltText(version)}
                onClick={() => onSelect(version.version)}
                className={cn(
                  'flex w-18 flex-col items-center gap-1 rounded-md border bg-card p-1 text-xs text-card-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  isSelected ? 'border-primary ring-1 ring-primary' : 'border-border',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
                <img
                  src={version.thumbUrl}
                  alt=""
                  width={64}
                  height={64}
                  onError={onImageError}
                  className="size-16 rounded bg-muted object-cover"
                />
                <span className={cn(isSelected && 'font-semibold')}>v{version.version}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Next version"
        disabled={!next}
        onClick={() => next && onSelect(next.version)}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
}
