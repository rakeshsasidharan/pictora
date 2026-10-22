'use client';

import { TERMINAL_JOB_STATUSES } from '@pictora/core';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { placeholderText, urlsMayHaveExpired } from '../lib/gallery_format';
import { POLL_INTERVAL_MS, altTextFor } from '../lib/generate_options';
import type { ActiveJobBody, GalleryImageBody, GalleryPageBody } from '../lib/images';
import type { JobStatusBody } from '../lib/jobs';
import { GENERATE_PATH, galleryImagePath } from '../lib/site';
import { ImageDetail } from './image_detail';

/** Screens at least this wide open the detail view as a modal; narrower ones go to its page. */
export const DETAIL_MODAL_QUERY = '(min-width: 720px)';

export interface GalleryProps {
  /** Display names of every model in the registry, for the detail view. */
  modelNames: Readonly<Record<string, string>>;
  /** How often running jobs are checked; tests shorten it. */
  pollIntervalMs?: number;
}

/** A tile, with when its presigned thumbnail URL was made. */
interface Tile extends GalleryImageBody {
  fetchedAt: number;
}

type Status = 'loading' | 'ready' | 'error';

async function fetchPage(cursor?: string): Promise<GalleryPageBody> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await fetch(`/api/images${query}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as GalleryPageBody;
}

/**
 * Adds freshly fetched tiles to the list, replacing older copies. Image IDs are ULIDs and the gallery is sorted
 * by them, newest first, so sorting by ID keeps the order whatever pages the tiles came from.
 */
function merge(current: Tile[], fresh: GalleryImageBody[]): Tile[] {
  const fetchedAt = Date.now();
  const byId = new Map(current.map((tile) => [tile.imageId, tile]));
  for (const image of fresh) byId.set(image.imageId, { ...image, fetchedAt });
  return [...byId.values()].sort((a, b) => (a.imageId < b.imageId ? 1 : -1));
}

/**
 * The private gallery (GAL-1, GAL-4, GEN-8): the user's images newest first, 24 at a time with more loaded on
 * scroll, and jobs still queued or running as placeholders at the top until they finish. A tile opens the detail
 * view, as a modal on wide screens and as its own page on narrow ones.
 */
export function Gallery({ modelNames, pollIntervalMs = POLL_INTERVAL_MS }: GalleryProps) {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [jobs, setJobs] = useState<ActiveJobBody[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [status, setStatus] = useState<Status>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [open, setOpen] = useState<string>();
  /** Bumped after each check of the running jobs, to schedule the next one. */
  const [jobCheck, setJobCheck] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const refreshing = useRef(false);

  /** Shows the first page; again later, it adds new images at the top and keeps the pages already loaded. */
  const showFirst = useCallback((page: GalleryPageBody) => {
    setTiles((current) => merge(current, page.images));
    setJobs(page.jobs ?? []);
    if (!loaded.current) setNextCursor(page.nextCursor);
    loaded.current = true;
    setStatus('ready');
  }, []);

  useEffect(() => {
    if (status !== 'loading') return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchPage();
        if (!cancelled) showFirst(page);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, showFirst]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await fetchPage(nextCursor);
      setTiles((current) => merge(current, page.images));
      setNextCursor(page.nextCursor);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  // Infinite scroll: the next page loads when the end of the grid comes into view.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !nextCursor || moreError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [nextCursor, moreError, loadMore]);

  // Running jobs: checked until each finishes, then the first page is fetched again to show the new images.
  useEffect(() => {
    if (jobs.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const finished = await Promise.all(
        jobs.map(async (job) => {
          try {
            const response = await fetch(`/api/jobs/${encodeURIComponent(job.jobId)}`, {
              cache: 'no-store',
            });
            if (response.status === 404) return true;
            if (!response.ok) return false;
            const body = (await response.json()) as JobStatusBody;
            return TERMINAL_JOB_STATUSES.includes(body.status);
          } catch {
            return false;
          }
        }),
      );
      if (cancelled) return;
      if (finished.some(Boolean)) {
        try {
          const page = await fetchPage();
          if (!cancelled) showFirst(page);
        } catch {
          // Tried again on the next check.
        }
      }
      if (!cancelled) setJobCheck((count) => count + 1);
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobs, jobCheck, pollIntervalMs, showFirst]);

  /** A thumbnail failed to load, most likely because its URL expired: fetch its page again (GAL-4). */
  async function refreshTile(index: number) {
    const tile = tiles[index];
    if (!tile || refreshing.current || !urlsMayHaveExpired(tile.fetchedAt)) return;
    refreshing.current = true;
    try {
      // The page that starts with this tile begins after the tile before it.
      const page = await fetchPage(tiles[index - 1]?.imageId);
      setTiles((current) => merge(current, page.images));
    } catch {
      // The tile stays as it is; the next failed load tries again.
    } finally {
      refreshing.current = false;
    }
  }

  function openTile(event: MouseEvent<HTMLAnchorElement>, imageId: string) {
    const newTab = event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0;
    if (newTab || !window.matchMedia?.(DETAIL_MODAL_QUERY).matches) return;
    event.preventDefault();
    setOpen(imageId);
  }

  function deleted(imageId: string) {
    setTiles((current) => current.filter((tile) => tile.imageId !== imageId));
    setOpen(undefined);
  }

  if (status === 'loading') {
    return (
      <p className="gallery-status" role="status">
        Loading your images…
      </p>
    );
  }
  if (status === 'error') {
    return (
      <div className="form-error" role="alert">
        <p>We couldn&apos;t load your gallery.</p>
        <button type="button" className="button" onClick={() => setStatus('loading')}>
          Try again
        </button>
      </div>
    );
  }
  if (tiles.length === 0 && jobs.length === 0) {
    return (
      <div className="gallery-empty">
        <p>Your gallery is empty. Images you create or upload appear here.</p>
        <Link className="button button-primary" href={GENERATE_PATH}>
          Create your first image
        </Link>
      </div>
    );
  }

  return (
    <>
      <ul className="gallery-grid" aria-label="Your images">
        {jobs.map((job) => (
          <li key={job.jobId} className="gallery-placeholder">
            <span className="gallery-placeholder-status" role="status">
              {placeholderText(job)}
            </span>
            <span className="gallery-placeholder-text">{job.text}</span>
          </li>
        ))}
        {tiles.map((tile, index) => (
          <li key={tile.imageId}>
            <Link
              href={galleryImagePath(tile.imageId)}
              className="gallery-tile"
              onClick={(event) => openTile(event, tile.imageId)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
              <img
                src={tile.thumbUrl}
                alt={altTextFor(tile.title)}
                loading="lazy"
                onError={() => void refreshTile(index)}
              />
              {tile.versionCount > 1 && (
                <span className="gallery-badge">{tile.versionCount} versions</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <div ref={sentinel} className="gallery-more">
        {loadingMore && (
          <p className="gallery-status" role="status">
            Loading more images…
          </p>
        )}
        {moreError && (
          <p className="form-error" role="alert">
            We couldn&apos;t load more images.
          </p>
        )}
        {nextCursor && !loadingMore && (
          <button type="button" className="button" onClick={() => void loadMore()}>
            {moreError ? 'Try again' : 'Load more'}
          </button>
        )}
      </div>
      {open && (
        <DetailModal onClose={() => setOpen(undefined)}>
          <ImageDetail imageId={open} modelNames={modelNames} onDeleted={deleted} />
        </DetailModal>
      )}
    </>
  );
}

function DetailModal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') onClose();
  }

  return (
    <div className="detail-modal-backdrop" onKeyDown={onKeyDown}>
      <div className="detail-modal" role="dialog" aria-modal="true" aria-label="Image details">
        {/* Focused on open, so Escape works straight away. */}
        <button type="button" className="detail-modal-close" onClick={onClose} autoFocus>
          Close
        </button>
        {children}
      </div>
    </div>
  );
}
