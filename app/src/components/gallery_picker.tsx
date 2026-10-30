'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { altTextFor } from '../lib/generate_options';
import type { GalleryImageBody, GalleryPageBody } from '../lib/images';

export interface GalleryPickerProps {
  /** Called with the image the user picked; its latest version is the one used. */
  onPick: (image: GalleryImageBody) => void;
  onClose: () => void;
}

/**
 * Picks a reference image from the gallery for an edit (EDIT-5), in a dialog: the user's images newest first, 24
 * at a time, with a button to load more.
 */
export function GalleryPicker({ onPick, onClose }: GalleryPickerProps) {
  const [images, setImages] = useState<GalleryImageBody[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  /** The page to load next: undefined for the first, then the cursor; null once loaded or loading. */
  const [request, setRequest] = useState<{ cursor?: string } | null>({});

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    void (async () => {
      try {
        const query = request.cursor ? `?cursor=${encodeURIComponent(request.cursor)}` : '';
        const response = await fetch(`/api/images${query}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const page = (await response.json()) as GalleryPageBody;
        if (cancelled) return;
        setImages((current) => [...current, ...page.images]);
        setNextCursor(page.nextCursor);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      } finally {
        if (!cancelled) setRequest(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>Choose a reference image</DialogTitle>
        </DialogHeader>
        {images.length > 0 && (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Your images">
            {images.map((image) => (
              <li key={image.imageId}>
                <Button
                  type="button"
                  variant="ghost"
                  className="aspect-square h-auto w-full overflow-hidden rounded-lg border bg-muted p-0 hover:ring-2 hover:ring-primary"
                  aria-label={`Use ${image.title}`}
                  onClick={() => onPick(image)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
                  <img
                    src={image.thumbUrl}
                    alt={altTextFor(image.title)}
                    loading="lazy"
                    className="size-full object-cover"
                  />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {state === 'loading' && (
          <div role="status" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            <span className="sr-only">Loading your images…</span>
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton
                key={index}
                aria-hidden="true"
                className="aspect-square w-full rounded-lg"
              />
            ))}
          </div>
        )}
        {state === 'error' && (
          <p className="text-sm text-destructive" role="alert">
            We couldn&apos;t load your gallery.
          </p>
        )}
        {state === 'ready' && images.length === 0 && (
          <p className="text-sm text-muted-foreground">Your gallery is empty.</p>
        )}
        {state !== 'loading' && (nextCursor || state === 'error') && (
          <Button
            type="button"
            variant="outline"
            className="self-center"
            onClick={() => {
              setState('loading');
              setRequest({
                cursor: state === 'error' && images.length === 0 ? undefined : nextCursor,
              });
            }}
          >
            {state === 'error' ? 'Try again' : 'Load more'}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
