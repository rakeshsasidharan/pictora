'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { altTextFor } from '../lib/generate_options';
import type { GalleryImageBody, GalleryPageBody } from '../lib/images';

export interface GalleryPickerProps {
  /** Called with the image the user picked; its latest version is the one used. */
  onPick: (image: GalleryImageBody) => void;
  onClose: () => void;
}

/**
 * Picks a reference image from the gallery for an edit (EDIT-5): the user's images newest first, 24 at a time,
 * with a button to load more.
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

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') onClose();
  }

  return (
    <div className="detail-modal-backdrop" onKeyDown={onKeyDown}>
      <div
        className="detail-modal gallery-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gallery-picker-heading"
      >
        {/* Focused on open, so Escape works straight away. */}
        <button type="button" className="detail-modal-close" onClick={onClose} autoFocus>
          Close
        </button>
        <h2 id="gallery-picker-heading">Choose a reference image</h2>
        {images.length > 0 && (
          <ul className="gallery-grid" aria-label="Your images">
            {images.map((image) => (
              <li key={image.imageId}>
                <button
                  type="button"
                  className="gallery-tile"
                  aria-label={`Use ${image.title}`}
                  onClick={() => onPick(image)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
                  <img src={image.thumbUrl} alt={altTextFor(image.title)} loading="lazy" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {state === 'loading' && (
          <p className="gallery-status" role="status">
            Loading your images…
          </p>
        )}
        {state === 'error' && (
          <p className="form-error" role="alert">
            We couldn&apos;t load your gallery.
          </p>
        )}
        {state === 'ready' && images.length === 0 && <p>Your gallery is empty.</p>}
        {state !== 'loading' && (nextCursor || state === 'error') && (
          <button
            type="button"
            className="button"
            onClick={() => {
              setState('loading');
              setRequest({
                cursor: state === 'error' && images.length === 0 ? undefined : nextCursor,
              });
            }}
          >
            {state === 'error' ? 'Try again' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
