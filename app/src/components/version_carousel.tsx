'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll_area';
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
      <ScrollArea
        type="hover"
        className="min-w-0 flex-1"
        viewportProps={{ className: 'snap-x snap-mandatory' }}
      >
        <ol aria-label="Versions" className="flex list-none gap-2 p-1 pb-3">
          {versions.map((version) => {
            const isSelected = version.version === selected;
            return (
              <li key={version.version} className="shrink-0 snap-start">
                <Button
                  ref={isSelected ? selectedButton : undefined}
                  type="button"
                  variant="ghost"
                  aria-pressed={isSelected}
                  aria-label={`Version ${version.version}`}
                  title={versionAltText(version)}
                  onClick={() => onSelect(version.version)}
                  className={cn(
                    'h-auto w-18 flex-col gap-1 border bg-card p-1 text-xs font-normal text-card-foreground',
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
                </Button>
              </li>
            );
          })}
        </ol>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
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
