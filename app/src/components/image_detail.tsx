'use client';

import { DownloadIcon, PencilIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert_dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll_area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { versionAltText } from '../lib/edit_options';
import { urlsMayHaveExpired, versionFields } from '../lib/gallery_format';
import type { ImageDetailBody } from '../lib/images';
import { notifyImagesChanged } from '../lib/images_changed';
import { downloadPath, editImagePath, rerunPath } from '../lib/site';
import { AltTextEditor } from './alt_text_editor';
import { ReportImage } from './report_image';
import { VersionCarousel } from './version_carousel';

export interface ImageDetailProps {
  imageId: string;
  /** The detail as the page read it on the server; the modal fetches it instead. */
  initial?: ImageDetailBody;
  /** Display names of every model in the registry, switched-off ones included. */
  modelNames: Readonly<Record<string, string>>;
  /** `h1` on the detail page, `h2` in the modal. */
  headingLevel?: 1 | 2;
  /**
   * Fill the container's height, as in the gallery modal (#145): the picture takes the space left, and the
   * settings card scrolls when the window is short, so the view is the same size whatever the prompt.
   */
  fill?: boolean;
  /** Called once the image is deleted. */
  onDeleted: (imageId: string) => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; detail: ImageDetailBody; fetchedAt: number };

/**
 * The detail view of a gallery image (GAL-2, GAL-3): the selected version with its prompt, enhanced prompt, edit
 * instruction, model, style, size, seed and date; the version history, as a row of thumbnails under the
 * picture (#125); and a toolbar to download the original PNG, rerun, edit, report and delete (after a
 * confirmation in an alert dialog); and the version's alt text, which the user can rewrite (#30). Presigned URLs that expired are fetched again when an image fails to load
 * (GAL-4). Long text (the prompt, enhanced prompt, what to avoid, the edit instruction) sits in a capped box that
 * scrolls, so it never pushes the picture or the actions out of view (#145).
 */
export function ImageDetail({
  imageId,
  initial,
  modelNames,
  headingLevel = 2,
  fill = false,
  onDeleted,
}: ImageDetailProps) {
  const [load, setLoad] = useState<Load>(() =>
    initial ? { state: 'ready', detail: initial, fetchedAt: Date.now() } : { state: 'loading' },
  );
  const [selected, setSelected] = useState<number>();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  /** Counts requests to fetch the detail; 0 while the server's copy is in use. */
  const [fetches, setFetches] = useState(initial ? 0 : 1);
  const [fetching, setFetching] = useState(!initial);

  useEffect(() => {
    if (fetches === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/images/${encodeURIComponent(imageId)}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const detail = (await response.json()) as ImageDetailBody;
        if (!cancelled) setLoad({ state: 'ready', detail, fetchedAt: Date.now() });
      } catch {
        // A failed refresh keeps what is shown.
        if (!cancelled)
          setLoad((current) => (current.state === 'ready' ? current : { state: 'error' }));
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageId, fetches]);

  function fetchAgain() {
    setFetching(true);
    setFetches((count) => count + 1);
  }

  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const SubHeading = headingLevel === 1 ? 'h2' : 'h3';
  if (load.state === 'loading') {
    return (
      <div data-slot="image-detail-loading" role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading image…</span>
        <Skeleton aria-hidden="true" className="h-7 w-2/3" />
        <Skeleton aria-hidden="true" className="aspect-square w-full max-w-xl rounded-lg" />
      </div>
    );
  }
  if (load.state === 'error') {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <p>We couldn&apos;t load this image.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLoad({ state: 'loading' });
              fetchAgain();
            }}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { detail, fetchedAt } = load;
  const versions = detail.versions;
  const current =
    versions.find((version) => version.version === (selected ?? detail.image.latestVersion)) ??
    versions.at(-1);
  if (!current) {
    return (
      <p className="text-sm text-destructive" role="alert">
        This image has no versions to show.
      </p>
    );
  }

  /** A presigned URL expired: ask for fresh ones, at most once per refresh window. */
  function refreshUrls() {
    if (fetching || !urlsMayHaveExpired(fetchedAt)) return;
    fetchAgain();
  }

  async function remove() {
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const response = await fetch(`/api/images/${encodeURIComponent(imageId)}`, {
        method: 'DELETE',
      });
      // Already gone counts as deleted.
      if (!response.ok && response.status !== 404) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setDeleteError(body.error ?? "We couldn't delete your image. Please try again.");
        return;
      }
      notifyImagesChanged();
      setConfirming(false);
      onDeleted(imageId);
    } catch {
      setDeleteError('Something went wrong. Check your connection and try again.');
    } finally {
      setDeleting(false);
    }
  }

  /** Keeps the version's alt text as saved, so the picture and the editor show it straight away. */
  function altTextSaved(version: number, altText: string | undefined) {
    setLoad((state) => {
      if (state.state !== 'ready') return state;
      const changed = state.detail.versions.map((item) =>
        item.version === version ? { ...item, altText } : item,
      );
      return { ...state, detail: { ...state.detail, versions: changed } };
    });
  }

  const fields = versionFields(current, modelNames);
  const canRerun = versions.some((version) => version.version === 1 && version.prompt);
  const versionCount = versions.length;

  return (
    <article
      data-slot="image-detail"
      className={cn('flex flex-col gap-4', fill && 'min-h-0 flex-1')}
      aria-labelledby="image-detail-heading"
    >
      <Heading
        id="image-detail-heading"
        className="shrink-0 pr-8 text-xl font-semibold break-words"
      >
        {detail.image.title}
      </Heading>
      <div
        className={cn(
          'grid gap-6',
          fill
            ? 'min-h-0 flex-1 grid-cols-[minmax(0,1fr)_18rem] grid-rows-[minmax(0,1fr)]'
            : 'md:grid-cols-[minmax(0,1fr)_18rem]',
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
          <img
            src={current.url}
            alt={versionAltText(current)}
            width={current.width}
            height={current.height}
            onError={refreshUrls}
            className={cn(
              'w-full rounded-lg border bg-muted object-contain',
              fill ? 'min-h-32 flex-1' : 'h-auto max-h-[70svh]',
            )}
          />
          {versionCount > 1 && (
            <VersionCarousel
              versions={versions}
              selected={current.version}
              onSelect={setSelected}
              onImageError={refreshUrls}
            />
          )}
          <div role="group" aria-label="Image actions" className="flex shrink-0 flex-wrap gap-2">
            <Button asChild>
              <a href={downloadPath(imageId, current.version)} download>
                <DownloadIcon aria-hidden="true" />
                Download PNG
              </a>
            </Button>
            {canRerun && (
              <Button asChild variant="outline">
                <Link href={rerunPath(imageId)}>
                  <RotateCcwIcon aria-hidden="true" />
                  Rerun
                </Link>
              </Button>
            )}
            <Button asChild variant="outline">
              <Link href={editImagePath(imageId, current.version)}>
                <PencilIcon aria-hidden="true" />
                Edit
              </Link>
            </Button>
            <ReportImage imageId={imageId} version={current.version} />
            <AlertDialog
              open={confirming}
              onOpenChange={(open) => {
                // Stays open while the delete runs, so its result is shown.
                if (deleting) return;
                setConfirming(open);
                if (!open) setDeleteError(undefined);
              }}
            >
              <AlertDialogTrigger asChild>
                <Button type="button" variant="destructive">
                  <Trash2Icon aria-hidden="true" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Delete this image
                    {versionCount > 1 ? ` and all ${versionCount} versions` : ''}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                {deleteError && (
                  <p className="text-sm text-destructive" role="alert">
                    {deleteError}
                  </p>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={deleting}
                    onClick={() => void remove()}
                  >
                    {deleting ? 'Deleting…' : 'Delete image'}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        <Card className={cn('h-fit gap-4 py-4', fill && 'max-h-full overflow-y-auto')}>
          <CardHeader className="px-4">
            <SubHeading className="text-base font-semibold">Version {current.version}</SubHeading>
          </CardHeader>
          <CardContent className="px-4">
            <dl data-slot="detail-fields" className="flex flex-col gap-3 text-sm">
              {fields.map((field) => (
                <div key={field.label} className="flex flex-col gap-0.5">
                  <dt className="text-xs font-medium text-muted-foreground">{field.label}</dt>
                  {field.scroll ? (
                    <dd>
                      <ScrollArea
                        type="auto"
                        viewportProps={{
                          // Focusable, so a long prompt can be scrolled from the keyboard.
                          tabIndex: 0,
                          role: 'group',
                          'aria-label': field.label,
                          className: 'max-h-32 rounded-sm',
                        }}
                      >
                        <p className="pr-3 break-words whitespace-pre-wrap">{field.value}</p>
                      </ScrollArea>
                    </dd>
                  ) : (
                    <dd className="break-words whitespace-pre-wrap">{field.value}</dd>
                  )}
                </div>
              ))}
            </dl>
            <div
              role="group"
              aria-labelledby="image-detail-alt-text"
              className="mt-3 flex flex-col gap-0.5 text-sm"
            >
              <p id="image-detail-alt-text" className="text-xs font-medium text-muted-foreground">
                Alt text
              </p>
              <AltTextEditor
                key={current.version}
                imageId={imageId}
                version={current}
                onSaved={(altText) => altTextSaved(current.version, altText)}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </article>
  );
}
