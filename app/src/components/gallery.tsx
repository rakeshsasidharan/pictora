'use client';

import { TERMINAL_JOB_STATUSES, normaliseTag } from '@pictora/core';
import { CheckCircle2Icon, CircleIcon, ImagesIcon, Loader2Icon, SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';
import type { BulkResult } from '../lib/collections';
import { useOrganiseData, type BulkChange } from '../lib/collections_client';
import {
  NO_FILTER,
  galleryApiUrl,
  galleryUrl,
  isFiltered,
  isRanked,
  type GalleryFilterState,
} from '../lib/gallery_filter';
import { placeholderText, urlsMayHaveExpired } from '../lib/gallery_format';
import { BATCH_POLL_INTERVAL_MS, POLL_INTERVAL_MS, altTextFor } from '../lib/generate_options';
import type { ActiveJobBody, GalleryImageBody, GalleryPageBody } from '../lib/images';
import type { JobStatusBody } from '../lib/jobs';
import { notifyImagesChanged } from '../lib/images_changed';
import { GENERATE_PATH, galleryImagePath } from '../lib/site';
import type { ToolCatalog } from '../lib/tool_catalog';
import { useReturnFocus } from '../lib/use_return_focus';
import { CollectionsDialog } from './collections_dialog';
import { GalleryToolbar } from './gallery_toolbar';
import { ImageDetail } from './image_detail';
import type { OrganiseChange } from './image_organiser';
import { SelectionBar } from './selection_bar';

/** Screens at least this wide open the detail view as a modal; narrower ones go to its page. */
export const DETAIL_MODAL_QUERY = '(min-width: 720px)';

/** The grid the tiles, placeholders and loading skeletons share: two columns at 360 px, up to five. */
const GRID_CLASS = 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

/** How many skeleton tiles show while the first page loads. */
const SKELETON_TILES = 8;

export interface GalleryProps {
  /** Display names of every model in the registry, for the detail view. */
  modelNames: Readonly<Record<string, string>>;
  /** The image tools the detail view offers (tech design 5.5). */
  tools?: ToolCatalog;
  /** How often running jobs are checked; tests shorten it. */
  pollIntervalMs?: number;
  /** How often scheduled batch jobs are checked when nothing else is running; tests shorten it. */
  batchPollIntervalMs?: number;
  /** The search and filters the page was opened with (`/gallery?q=&tag=&collection=`, tech design 4.2). */
  initialFilter?: GalleryFilterState;
  /** Debounce for typing in the search; tests shorten it. */
  searchDebounceMs?: number;
}

/** A tile, with when its presigned thumbnail URL was made. */
interface Tile extends GalleryImageBody {
  fetchedAt: number;
}

type Status = 'loading' | 'ready' | 'error';

async function fetchPage(filter: GalleryFilterState, cursor?: string): Promise<GalleryPageBody> {
  const response = await fetch(galleryApiUrl(filter, cursor), { cache: 'no-store' });
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

/** The tile as it is in another collection, or in none. */
function inCollection(tile: Tile, collectionId: string | null | undefined): Tile {
  const next = { ...tile };
  if (collectionId) next.collectionId = collectionId;
  else delete next.collectionId;
  return next;
}

/**
 * Adds a page of ranked results (a search or tag filter) in the order the server ranked them: tiles already
 * shown are refreshed in place, and new ones go at the end.
 */
function append(current: Tile[], fresh: GalleryImageBody[]): Tile[] {
  const fetchedAt = Date.now();
  const byId = new Map(fresh.map((image) => [image.imageId, image]));
  const refreshed = current.map((tile) => {
    const image = byId.get(tile.imageId);
    return image ? { ...image, fetchedAt } : tile;
  });
  const shown = new Set(current.map((tile) => tile.imageId));
  return [
    ...refreshed,
    ...fresh.filter((image) => !shown.has(image.imageId)).map((image) => ({ ...image, fetchedAt })),
  ];
}

/**
 * The private gallery (GAL-1, GAL-4, GEN-8): the user's images newest first, 24 at a time with more loaded on
 * scroll, and jobs still queued, running or scheduled as placeholders at the top until they finish. A tile opens the detail
 * view, as a modal on wide screens and as its own page on narrow ones.
 *
 * Above the grid, a search and filters by collection and tag (tech design 4.2), kept in the address bar so a
 * filtered view can be linked to; ranked results keep the server's order. In select mode, a tile toggles its
 * selection instead, and a bar offers bulk moves, tags and deletes.
 */
export function Gallery({
  modelNames,
  tools,
  pollIntervalMs = POLL_INTERVAL_MS,
  batchPollIntervalMs = BATCH_POLL_INTERVAL_MS,
  initialFilter = NO_FILTER,
  searchDebounceMs,
}: GalleryProps) {
  const [filter, setFilter] = useState(initialFilter);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [jobs, setJobs] = useState<ActiveJobBody[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [total, setTotal] = useState<number>();
  const [status, setStatus] = useState<Status>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [open, setOpen] = useState<string>();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [managing, setManaging] = useState(false);
  /** Bumped after each check of the running jobs, to schedule the next one. */
  const [jobCheck, setJobCheck] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const refreshing = useRef(false);
  const data = useOrganiseData();
  const ranked = isRanked(filter);
  const filtered = isFiltered(filter);

  /** Shows the first page; again later, it adds new images at the top and keeps the pages already loaded. */
  const showFirst = useCallback((page: GalleryPageBody, rankedPage: boolean) => {
    setTiles((current) =>
      rankedPage ? append(current, page.images) : merge(current, page.images),
    );
    setJobs(page.jobs ?? []);
    setTotal(page.total);
    if (!loaded.current) setNextCursor(page.nextCursor);
    loaded.current = true;
    setStatus('ready');
  }, []);

  useEffect(() => {
    if (status !== 'loading') return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchPage(filter);
        if (!cancelled) showFirst(page, isRanked(filter));
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, filter, showFirst]);

  // A view of one collection names it in the menu, so the collections load straight away.
  useEffect(() => {
    if (initialFilter.collection) void data.load();
  }, [initialFilter.collection, data]);

  /** Shows another search or filter from its first page, and keeps it in the address bar. */
  function changeFilter(next: GalleryFilterState) {
    setFilter(next);
    setTiles([]);
    setJobs([]);
    setNextCursor(undefined);
    setTotal(undefined);
    setMoreError(false);
    setSelected(new Set());
    loaded.current = false;
    setStatus('loading');
    window.history.replaceState(window.history.state, '', galleryUrl(next));
  }

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await fetchPage(filter, nextCursor);
      setTiles((current) => (ranked ? append(current, page.images) : merge(current, page.images)));
      setNextCursor(page.nextCursor);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, filter, ranked]);

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
  // Only the whole gallery lists jobs, so a search or filter never polls.
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
            const page = await fetchPage(NO_FILTER);
            if (!cancelled) showFirst(page, false);
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
      // Ranked results page by position; otherwise the page that starts with this tile begins after the one before.
      const cursor = ranked ? (index > 0 ? String(index) : undefined) : tiles[index - 1]?.imageId;
      const page = await fetchPage(filter, cursor);
      setTiles((current) => (ranked ? append(current, page.images) : merge(current, page.images)));
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

  function toggle(imageId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(imageId)) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
  }

  /** Takes tiles out of the view and the selection, and out of the count of matches. */
  function drop(imageIds: ReadonlySet<string>) {
    if (imageIds.size === 0) return;
    setTiles((current) => current.filter((tile) => !imageIds.has(tile.imageId)));
    setSelected((current) => new Set([...current].filter((imageId) => !imageIds.has(imageId))));
    setTotal((count) => (count === undefined ? count : Math.max(0, count - imageIds.size)));
  }

  function deleted(imageId: string) {
    drop(new Set([imageId]));
    setOpen(undefined);
  }

  /**
   * Shows a bulk change on the tiles it changed. The selection stays, for another change to the same images,
   * except for images that left the view.
   */
  function bulkChanged(change: BulkChange, results: BulkResult[]) {
    const done = new Set(results.filter((result) => result.ok).map((result) => result.imageId));
    if (change.action === 'delete') {
      drop(done);
      notifyImagesChanged();
      return;
    }
    // Images that no longer belong in a filtered view leave it.
    const leaving =
      (change.action === 'move' &&
        filter.collection !== '' &&
        change.collectionId !== filter.collection) ||
      (change.action === 'removeTag' &&
        filter.tag !== '' &&
        normaliseTag(filter.tag) === change.tag);
    if (leaving) {
      drop(done);
      return;
    }
    setTiles((current) =>
      current.map((tile) => {
        if (!done.has(tile.imageId)) return tile;
        if (change.action === 'move') return inCollection(tile, change.collectionId);
        const tags =
          change.action === 'addTag'
            ? [...new Set([...tile.tags, change.tag])].sort()
            : tile.tags.filter((tag) => tag !== change.tag);
        return { ...tile, tags };
      }),
    );
  }

  /** The detail view moved or tagged an image: the tile keeps up. */
  function organised(imageId: string, change: OrganiseChange) {
    setTiles((current) =>
      current.map((tile) => {
        if (tile.imageId !== imageId) return tile;
        return { ...inCollection(tile, change.collection?.collectionId), tags: change.tags };
      }),
    );
  }

  function collectionDeleted(collectionId: string) {
    if (filter.collection === collectionId) {
      changeFilter({ ...filter, collection: '' });
      return;
    }
    setTiles((current) =>
      current.map((tile) => {
        return tile.collectionId === collectionId ? inCollection(tile, null) : tile;
      }),
    );
  }

  const selectedIds = tiles
    .filter((tile) => selected.has(tile.imageId))
    .map((tile) => tile.imageId);
  const selectedTags = useMemo(
    () =>
      [
        ...new Set(tiles.filter((tile) => selected.has(tile.imageId)).flatMap((tile) => tile.tags)),
      ].sort(),
    [tiles, selected],
  );

  const toolbar = (
    <GalleryToolbar
      filter={filter}
      onChange={changeFilter}
      data={data}
      selecting={selecting}
      onToggleSelecting={() => {
        setSelecting((current) => !current);
        setSelected(new Set());
      }}
      onManageCollections={() => setManaging(true)}
      debounceMs={searchDebounceMs}
    />
  );
  const dialogs = (
    <CollectionsDialog
      open={managing}
      onOpenChange={setManaging}
      data={data}
      onDeleted={collectionDeleted}
    />
  );

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <div data-slot="gallery-loading" role="status" className={GRID_CLASS}>
          <span className="sr-only">Loading your images…</span>
          {Array.from({ length: SKELETON_TILES }, (_, index) => (
            <Skeleton key={index} aria-hidden="true" className="aspect-square w-full rounded-xl" />
          ))}
        </div>
        {dialogs}
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <p>We couldn&apos;t load your gallery.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setStatus('loading')}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
        {dialogs}
      </div>
    );
  }
  if (tiles.length === 0 && jobs.length === 0 && !filtered) {
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
    <div className="flex flex-col gap-4">
      {toolbar}
      {filtered && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <p role="status">
            {total !== undefined
              ? `${total} ${total === 1 ? 'image matches' : 'images match'}`
              : 'Showing one collection'}
          </p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => changeFilter(NO_FILTER)}
          >
            Show all images
          </Button>
        </div>
      )}
      {tiles.length === 0 && jobs.length === 0 ? (
        <Card data-slot="gallery-no-matches" className="items-center px-6 py-12 text-center">
          <SearchXIcon className="size-10 text-muted-foreground" aria-hidden="true" />
          <p className="max-w-sm text-muted-foreground">No images match.</p>
        </Card>
      ) : (
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
          {tiles.map((tile, index) => {
            const picture = (
              <Card
                className={cn(
                  'relative aspect-square gap-0 overflow-hidden py-0 transition-shadow group-hover:shadow-md',
                  selected.has(tile.imageId) && 'ring-[3px] ring-primary',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
                <img
                  src={tile.thumbUrl}
                  alt={altTextFor(tile.title)}
                  loading="lazy"
                  onError={() => void refreshTile(index)}
                  className="size-full bg-muted object-cover transition-transform group-hover:scale-105"
                />
                {selecting && (
                  <span
                    aria-hidden="true"
                    className="absolute top-2 left-2 rounded-full bg-background/90 text-primary shadow-sm"
                  >
                    {selected.has(tile.imageId) ? (
                      <CheckCircle2Icon className="size-6" />
                    ) : (
                      <CircleIcon className="size-6 text-muted-foreground" />
                    )}
                  </span>
                )}
                {tile.versionCount > 1 && (
                  <Badge variant="secondary" className="absolute right-2 bottom-2 shadow-sm">
                    {tile.versionCount} versions
                  </Badge>
                )}
              </Card>
            );
            return (
              <li key={tile.imageId}>
                {selecting ? (
                  <Toggle
                    pressed={selected.has(tile.imageId)}
                    onPressedChange={() => toggle(tile.imageId)}
                    aria-label={`Select ${altTextFor(tile.title)}`}
                    className="group block h-auto w-full rounded-xl p-0 hover:bg-transparent data-[state=on]:bg-transparent"
                  >
                    {picture}
                  </Toggle>
                ) : (
                  <Link
                    href={galleryImagePath(tile.imageId)}
                    className="group block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={(event) => openTile(event, tile.imageId)}
                  >
                    {picture}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div ref={sentinel} className="flex flex-col items-center gap-2">
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
      {selecting && (
        <SelectionBar
          selected={selectedIds}
          selectedTags={selectedTags}
          shown={tiles.length}
          data={data}
          onSelectAll={() => setSelected(new Set(tiles.map((tile) => tile.imageId)))}
          onClear={() => setSelected(new Set())}
          onChanged={bulkChanged}
        />
      )}
      {open && (
        <DetailModal
          imageId={open}
          modelNames={modelNames}
          tools={tools}
          onDeleted={deleted}
          onOrganised={organised}
          onClose={() => setOpen(undefined)}
        />
      )}
      {dialogs}
    </div>
  );
}

/**
 * The detail view as a modal, on wide screens (GAL-2). The focus stays inside while it is open and goes back to
 * the tile that opened it on close (#30).
 */
function DetailModal({
  imageId,
  modelNames,
  tools,
  onDeleted,
  onOrganised,
  onClose,
}: {
  imageId: string;
  modelNames: Readonly<Record<string, string>>;
  tools?: ToolCatalog;
  onDeleted: (imageId: string) => void;
  onOrganised: (imageId: string, change: OrganiseChange) => void;
  onClose: () => void;
}) {
  const returnFocus = useReturnFocus();

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      {/* The same height whatever the prompt: it fits the window, centred, and the detail fills it (#145). */}
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={returnFocus}
        className="flex h-[min(calc(100svh-2rem),52rem)] flex-col overflow-y-auto sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">Image details</DialogTitle>
        <ImageDetail
          imageId={imageId}
          modelNames={modelNames}
          tools={tools}
          onDeleted={onDeleted}
          onOrganised={onOrganised}
          fill
        />
      </DialogContent>
    </Dialog>
  );
}
