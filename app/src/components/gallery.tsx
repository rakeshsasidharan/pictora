'use client';

import { TERMINAL_JOB_STATUSES } from '@pictora/core';
import { ImagesIcon, Loader2Icon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { placeholderText, urlsMayHaveExpired } from '../lib/gallery_format';
import { BATCH_POLL_INTERVAL_MS, POLL_INTERVAL_MS, altTextFor } from '../lib/generate_options';
import type { ActiveJobBody, GalleryImageBody, GalleryPageBody } from '../lib/images';
import type { JobStatusBody } from '../lib/jobs';
import { GENERATE_PATH, galleryImagePath } from '../lib/site';
import { ImageDetail } from './image_detail';

/** Screens at least this wide open the detail view as a modal; narrower ones go to its page. */
export const DETAIL_MODAL_QUERY = '(min-width: 720px)';

/** The grid the tiles, placeholders and loading skeletons share: two columns at 360 px, up to five. */
const GRID_CLASS = 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

/** How many skeleton tiles show while the first page loads. */
const SKELETON_TILES = 8;

export interface GalleryProps {
  /** Display names of every model in the registry, for the detail view. */
  modelNames: Readonly<Record<string, string>>;
  /** How often running jobs are checked; tests shorten it. */
  pollIntervalMs?: number;
  /** How often scheduled batch jobs are checked when nothing else is running; tests shorten it. */
  batchPollIntervalMs?: number;
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
 * scroll, and jobs still queued, running or scheduled as placeholders at the top until they finish. A tile opens the detail
 * view, as a modal on wide screens and as its own page on narrow ones.
 */
export function Gallery({
  modelNames,
  pollIntervalMs = POLL_INTERVAL_MS,
  batchPollIntervalMs = BATCH_POLL_INTERVAL_MS,
}: GalleryProps) {
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
  // Scheduled batch jobs take hours, so while they are all that's left they are checked once a minute.
  const onlyBatchJobs = jobs.every(
    (job) => job.status === 'scheduled' || job.status === 'submitted',
  );
  useEffect(() => {
    if (jobs.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(
      async () => {
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
      },
      onlyBatchJobs ? batchPollIntervalMs : pollIntervalMs,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobs, jobCheck, pollIntervalMs, batchPollIntervalMs, onlyBatchJobs, showFirst]);

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
      <div data-slot="gallery-loading" role="status" className={GRID_CLASS}>
        <span className="sr-only">Loading your images…</span>
        {Array.from({ length: SKELETON_TILES }, (_, index) => (
          <Skeleton key={index} aria-hidden="true" className="aspect-square w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (status === 'error') {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <p>We couldn&apos;t load your gallery.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setStatus('loading')}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (tiles.length === 0 && jobs.length === 0) {
    return (
      <Card data-slot="gallery-empty" className="items-center px-6 py-12 text-center">
        <ImagesIcon className="size-10 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-sm text-muted-foreground">
          Your gallery is empty. Images you create or upload appear here.
        </p>
        <Button asChild>
          <Link href={GENERATE_PATH}>Create your first image</Link>
        </Button>
      </Card>
    );
  }

  return (
    <>
      <ul className={GRID_CLASS} aria-label="Your images">
        {jobs.map((job) => (
          <li key={job.jobId}>
            <Card className="aspect-square justify-center gap-2 border-dashed bg-muted/40 px-3 py-3 text-center">
              <span
                className="flex items-center justify-center gap-1.5 text-sm font-medium"
                role="status"
              >
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                {placeholderText(job)}
              </span>
              <span className="line-clamp-3 text-xs break-words text-muted-foreground">
                {job.text}
              </span>
            </Card>
          </li>
        ))}
        {tiles.map((tile, index) => (
          <li key={tile.imageId}>
            <Link
              href={galleryImagePath(tile.imageId)}
              className="group block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={(event) => openTile(event, tile.imageId)}
            >
              <Card className="relative aspect-square gap-0 overflow-hidden py-0 transition-shadow group-hover:shadow-md">
                {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
                <img
                  src={tile.thumbUrl}
                  alt={altTextFor(tile.title)}
                  loading="lazy"
                  onError={() => void refreshTile(index)}
                  className="size-full bg-muted object-cover transition-transform group-hover:scale-105"
                />
                {tile.versionCount > 1 && (
                  <Badge variant="secondary" className="absolute right-2 bottom-2 shadow-sm">
                    {tile.versionCount} versions
                  </Badge>
                )}
              </Card>
            </Link>
          </li>
        ))}
      </ul>
      <div ref={sentinel} className="mt-6 flex flex-col items-center gap-2">
        {loadingMore && (
          <p className="text-sm text-muted-foreground" role="status">
            Loading more images…
          </p>
        )}
        {moreError && (
          <p className="text-sm text-destructive" role="alert">
            We couldn&apos;t load more images.
          </p>
        )}
        {nextCursor && !loadingMore && (
          <Button type="button" variant="outline" onClick={() => void loadMore()}>
            {moreError ? 'Try again' : 'Load more'}
          </Button>
        )}
      </div>
      {open && (
        <Dialog open onOpenChange={(next) => !next && setOpen(undefined)}>
          {/* The same height whatever the prompt: it fits the window, centred, and the detail fills it (#145). */}
          <DialogContent
            aria-describedby={undefined}
            className="flex h-[min(calc(100svh-2rem),52rem)] flex-col overflow-y-auto sm:max-w-5xl"
          >
            <DialogTitle className="sr-only">Image details</DialogTitle>
            <ImageDetail imageId={open} modelNames={modelNames} onDeleted={deleted} fill />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
