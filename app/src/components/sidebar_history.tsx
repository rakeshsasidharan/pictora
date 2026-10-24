'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@/components/ui/sidebar';
import { relativeTimeText, urlsMayHaveExpired } from '../lib/gallery_format';
import type { GalleryImageBody, GalleryPageBody } from '../lib/images';
import { useImagesChanged } from '../lib/images_changed';
import { galleryImagePath } from '../lib/site';

/** How many recent images the sidebar lists. */
export const HISTORY_SIZE = 10;

type HistoryState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; images: GalleryImageBody[]; fetchedAt: number };

/** Reads the newest images from `GET /api/images?limit=10`. */
async function fetchHistory(): Promise<HistoryState> {
  try {
    const response = await fetch(`/api/images?limit=${HISTORY_SIZE}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = (await response.json()) as GalleryPageBody;
    return { phase: 'ready', images: page.images.slice(0, HISTORY_SIZE), fetchedAt: Date.now() };
  } catch {
    return { phase: 'error' };
  }
}

/** A refresh that fails keeps the list already showing; the next change or retry tries again. */
function keepShown(previous: HistoryState, next: HistoryState): HistoryState {
  return next.phase === 'error' && previous.phase === 'ready' ? previous : next;
}

/**
 * The sidebar's history (GAL-1): the user's 10 most recent images, newest first, each linking to its detail
 * page. It loads them from `GET /api/images?limit=10` and again whenever `notifyImagesChanged()` says a job
 * finished or an image was added or deleted. A thumbnail that fails to load after its presigned URL may have
 * expired loads the list again (GAL-4).
 */
export function SidebarHistory() {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const [state, setState] = useState<HistoryState>({ phase: 'loading' });

  const load = useCallback(() => {
    void fetchHistory().then((next) => setState((previous) => keepShown(previous, next)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchHistory().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useImagesChanged(load);

  function retry() {
    setState({ phase: 'loading' });
    load();
  }

  function thumbFailed() {
    if (state.phase === 'ready' && urlsMayHaveExpired(state.fetchedAt)) load();
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>History</SidebarGroupLabel>
      <SidebarGroupContent>
        {state.phase === 'loading' && (
          <SidebarMenu aria-label="Loading history" aria-busy="true">
            {Array.from({ length: 4 }, (_, index) => (
              <SidebarMenuItem key={index}>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
        {state.phase === 'error' && (
          <div role="alert" className="flex flex-col items-start gap-1 px-2 text-xs">
            <p className="text-sidebar-foreground/70">We couldn&apos;t load your history.</p>
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={retry}>
              Try again
            </Button>
          </div>
        )}
        {state.phase === 'ready' && state.images.length === 0 && (
          <p className="px-2 text-xs text-sidebar-foreground/70">No images yet</p>
        )}
        {state.phase === 'ready' && state.images.length > 0 && (
          <nav aria-label="History">
            <SidebarMenu>
              {state.images.map((image) => {
                const href = galleryImagePath(image.imageId);
                return (
                  <SidebarMenuItem key={image.imageId}>
                    <SidebarMenuButton asChild size="lg" isActive={pathname === href}>
                      <Link href={href} onClick={() => isMobile && setOpenMobile(false)}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
                        <img
                          src={image.thumbUrl}
                          alt=""
                          loading="lazy"
                          className="size-8 shrink-0 rounded-md bg-sidebar-accent object-cover"
                          onError={thumbFailed}
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{image.title}</span>
                          {image.createdAt && (
                            <time
                              dateTime={image.createdAt}
                              className="truncate text-xs text-sidebar-foreground/70"
                            >
                              {relativeTimeText(image.createdAt)}
                            </time>
                          )}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </nav>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
