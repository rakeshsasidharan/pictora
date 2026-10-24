'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { versionAltText, versionDescription } from '../lib/edit_options';
import { urlsMayHaveExpired, versionFields } from '../lib/gallery_format';
import type { ImageDetailBody } from '../lib/images';
import { notifyImagesChanged } from '../lib/images_changed';
import { downloadPath, editImagePath, rerunPath } from '../lib/site';
import { ReportImage } from './report_image';

export interface ImageDetailProps {
  imageId: string;
  /** The detail as the page read it on the server; the modal fetches it instead. */
  initial?: ImageDetailBody;
  /** Display names of every model in the registry, switched-off ones included. */
  modelNames: Readonly<Record<string, string>>;
  /** `h1` on the detail page, `h2` in the modal. */
  headingLevel?: 1 | 2;
  /** Called once the image is deleted. */
  onDeleted: (imageId: string) => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; detail: ImageDetailBody; fetchedAt: number };

/**
 * The detail view of a gallery image (GAL-2, GAL-3): the selected version with its prompt, enhanced prompt, edit
 * instruction, model, style, size, seed and date; the version history; and the actions to download the
 * original PNG, rerun, edit, report and delete (after a confirmation). Presigned URLs that expired are fetched
 * again when an image fails to load (GAL-4).
 */
export function ImageDetail({
  imageId,
  initial,
  modelNames,
  headingLevel = 2,
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
      <p className="gallery-status" role="status">
        Loading image…
      </p>
    );
  }
  if (load.state === 'error') {
    return (
      <div className="form-error" role="alert">
        <p>We couldn&apos;t load this image.</p>
        <button
          type="button"
          className="button"
          onClick={() => {
            setLoad({ state: 'loading' });
            fetchAgain();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const { detail, fetchedAt } = load;
  const versions = detail.versions;
  const current =
    versions.find((version) => version.version === (selected ?? detail.image.latestVersion)) ??
    versions.at(-1);
  if (!current) {
    return (
      <p className="form-error" role="alert">
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
      onDeleted(imageId);
    } catch {
      setDeleteError('Something went wrong. Check your connection and try again.');
    } finally {
      setDeleting(false);
    }
  }

  const fields = versionFields(current, modelNames);
  const canRerun = versions.some((version) => version.version === 1 && version.prompt);
  const versionCount = versions.length;

  return (
    <article className="image-detail" aria-labelledby="image-detail-heading">
      <Heading id="image-detail-heading" className="image-detail-title">
        {detail.image.title}
      </Heading>
      <div className="image-detail-layout">
        <div className="image-detail-viewer">
          {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
          <img
            src={current.url}
            alt={versionAltText(current)}
            width={current.width}
            height={current.height}
            onError={refreshUrls}
          />
          <div className="result-actions">
            <a
              className="button button-primary"
              href={downloadPath(imageId, current.version)}
              download
            >
              Download PNG
            </a>
            {canRerun && (
              <Link className="button" href={rerunPath(imageId)}>
                Rerun
              </Link>
            )}
            <Link className="button" href={editImagePath(imageId, current.version)}>
              Edit
            </Link>
            <button
              type="button"
              className="button button-danger"
              aria-expanded={confirming}
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
            <ReportImage imageId={imageId} version={current.version} />
          </div>
          {confirming && (
            <div className="delete-confirm" role="alertdialog" aria-labelledby="delete-heading">
              <p id="delete-heading">
                Delete this image
                {versionCount > 1 ? ` and all ${versionCount} versions` : ''}? This can&apos;t be
                undone.
              </p>
              {deleteError && (
                <p className="form-error" role="alert">
                  {deleteError}
                </p>
              )}
              <div className="result-actions">
                <button
                  type="button"
                  className="button button-danger"
                  disabled={deleting}
                  onClick={() => void remove()}
                >
                  {deleting ? 'Deleting…' : 'Delete image'}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={deleting}
                  onClick={() => {
                    setConfirming(false);
                    setDeleteError(undefined);
                  }}
                  autoFocus
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="image-detail-info">
          <SubHeading>Version {current.version}</SubHeading>
          <dl className="detail-fields">
            {fields.map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>

          {versionCount > 1 && (
            <>
              <SubHeading>Versions</SubHeading>
              <ol className="version-list" aria-label="Versions">
                {versions.map((version) => (
                  <li key={version.version}>
                    <button
                      type="button"
                      className="version-item"
                      aria-pressed={version.version === current.version}
                      aria-label={`Version ${version.version}`}
                      onClick={() => setSelected(version.version)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
                      <img
                        src={version.thumbUrl}
                        alt=""
                        width={56}
                        height={56}
                        onError={refreshUrls}
                      />
                      <span className="version-text">
                        <span className="version-number">Version {version.version}</span>
                        <span>{versionDescription(version)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
