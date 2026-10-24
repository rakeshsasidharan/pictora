'use client';

import { MAX_PROMPT_LENGTH, QUALITIES, imageKey, type Quality } from '@pictora/core';
import Link from 'next/link';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import {
  defaultEditModel,
  editModels,
  editQualityFor,
  maxReferences,
  versionAltText,
} from '../lib/edit_options';
import {
  DEFAULT_QUALITY,
  QUALITY_LABELS,
  STATUS_LABELS,
  costPerImage,
  pointsText,
  premiumPausedText,
  qualityPaused,
} from '../lib/generate_options';
import type { GalleryImageBody, ImageDetailBody, ImageVersionBody } from '../lib/images';
import { notifyImagesChanged } from '../lib/images_changed';
import type { JobStatusBody, MeBody } from '../lib/jobs';
import type { PublicModel } from '../lib/models_response';
import { GENERATE_PATH, downloadPath } from '../lib/site';
import { browserUploadClient, UploadError, type UploadClient } from '../lib/upload_client';
import { UPLOAD_ACCEPT, uploadFileError } from '../lib/upload_files';
import { useJobStatus } from '../lib/use_job_status';
import { GalleryPicker } from './gallery_picker';
import type { PointsLeft } from './generate_screen';
import { ReportImage } from './report_image';
import { VersionCard } from './version_card';

export interface EditPanelProps {
  detail: ImageDetailBody;
  /** The signed-in user's `sub`, which gallery reference keys start with (`users/<sub>/…`). */
  ownerSub: string;
  /** The enabled models the app can queue jobs for; only those that edit are offered. */
  models: PublicModel[];
  points: PointsLeft;
  /** The version selected first, for example from `?version=`; the latest when not given. */
  initialVersion?: number;
  /** While premium qualities are paused (tech design 4.1). */
  premiumPausedUntil?: string;
  /** Sends reference uploads to S3; tests swap it. */
  uploadClient?: UploadClient;
  /** Polling settings; tests shorten them. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/** A reference image added to the next edit (EDIT-5). */
interface Reference {
  key: string;
  name: string;
}

interface SubmittedEdit {
  id: string;
  pointsReserved: number;
  parentVersion: number;
  instruction: string;
}

/**
 * The edit panel (EDIT-1 to EDIT-5): the image's versions as a chat-style list, each with the words it was edited
 * with. Selecting a version shows it to view, download or report, and the next edit starts from it. The user
 * describes a change, sees what it costs, and the new version appears when its job finishes. Reference images
 * are offered only for models that take them.
 */
export function EditPanel({
  detail,
  ownerSub,
  models,
  points: initialPoints,
  initialVersion,
  premiumPausedUntil,
  uploadClient = browserUploadClient,
  pollIntervalMs,
  pollTimeoutMs,
}: EditPanelProps) {
  const available = editModels(models);
  const imageId = detail.image.imageId;
  const [versions, setVersions] = useState<ImageVersionBody[]>(detail.versions);
  const [selected, setSelected] = useState<number>(() => {
    const wanted = initialVersion ?? detail.image.latestVersion;
    return detail.versions.some((version) => version.version === wanted)
      ? wanted
      : (detail.versions.at(-1)?.version ?? 1);
  });
  const [modelId, setModelId] = useState(() => defaultEditModel(available)?.id);
  const [quality, setQuality] = useState<Quality>(() => {
    const model = defaultEditModel(available);
    return model ? editQualityFor(model, DEFAULT_QUALITY) : DEFAULT_QUALITY;
  });
  const [instruction, setInstruction] = useState('');
  const [references, setReferences] = useState<Reference[]>([]);
  const [referenceStatus, setReferenceStatus] = useState<string>();
  const [referenceError, setReferenceError] = useState<string>();
  const [points, setPoints] = useState(initialPoints);
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<SubmittedEdit>();
  const [refreshError, setRefreshError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const referenceInput = useRef<HTMLInputElement>(null);

  const refreshPoints = useCallback(async () => {
    try {
      const response = await fetch('/api/me', { cache: 'no-store' });
      if (!response.ok) return;
      const me = (await response.json()) as MeBody;
      setPoints({ left: me.pointsLeft, limit: me.dailyLimit });
    } catch {
      // The display catches up on the next refresh.
    }
  }, []);

  const finished = useCallback(
    async (result: JobStatusBody) => {
      void refreshPoints();
      notifyImagesChanged();
      if (result.status !== 'succeeded') return;
      const created = result.images?.[0]?.version;
      try {
        const response = await fetch(`/api/images/${encodeURIComponent(imageId)}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = (await response.json()) as ImageDetailBody;
        setVersions(next.versions);
        setRefreshError(undefined);
        if (created !== undefined) setSelected(created);
      } catch {
        setRefreshError('Your new version is saved. Refresh the page to see it.');
      }
    },
    [imageId, refreshPoints],
  );
  const poll = useJobStatus(job?.id, {
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
    onFinish: (result) => void finished(result),
  });

  const model = available.find((candidate) => candidate.id === modelId);
  const current = versions.find((version) => version.version === selected) ?? versions.at(-1);
  if (!model || !current) {
    return (
      <div className="edit-panel">
        <h1>Edit image</h1>
        <p className="form-error" role="alert">
          No image models can edit right now. Please try again later.
        </p>
      </div>
    );
  }

  const allowedReferences = maxReferences(model);
  const sentReferences = references.slice(0, allowedReferences);
  const cost = costPerImage(model, quality) ?? 0;
  const affordable = cost <= points.left;
  const status = poll.job?.status;
  const jobActive =
    job !== undefined &&
    !poll.timedOut &&
    !poll.lost &&
    (status === undefined || status === 'queued' || status === 'running');
  const jobFailed = status === 'failed' || status === 'blocked';
  const busy = submitting || jobActive || referenceStatus !== undefined;

  function chooseModel(next: PublicModel) {
    setModelId(next.id);
    setQuality((value) => editQualityFor(next, value));
  }

  async function addReference(file: File) {
    const invalid = uploadFileError(file);
    if (invalid) {
      setReferenceError(invalid);
      return;
    }
    setReferenceError(undefined);
    setReferenceStatus(`Uploading ${file.name}… 0%`);
    try {
      const ticket = await uploadClient.start(file);
      await uploadClient.send(ticket, file, (percent) =>
        setReferenceStatus(`Uploading ${file.name}… ${percent}%`),
      );
      setReferences((list) => [...list, { key: ticket.key, name: file.name }]);
    } catch (error) {
      setReferenceError(
        error instanceof UploadError
          ? error.message
          : "We couldn't upload your reference image. Please try again.",
      );
    } finally {
      setReferenceStatus(undefined);
    }
  }

  /** A gallery image as a reference: its latest version, which the job API checks belongs to the user. */
  function pickReference(image: GalleryImageBody) {
    setPicking(false);
    const key = imageKey(ownerSub, image.imageId, image.latestVersion);
    setReferences((list) =>
      list.some((reference) => reference.key === key)
        ? list
        : [...list, { key, name: image.title }],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!model || !current || busy) return;
    const text = instruction.trim();
    if (!text) {
      setFormError('Describe the change you want.');
      return;
    }
    if (!affordable) return;
    setFormError(undefined);
    setRefreshError(undefined);
    setSubmitting(true);
    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'edit',
          imageId,
          parentVersion: current.version,
          instruction: text,
          modelId: model.id,
          quality,
          ...(sentReferences.length > 0
            ? { referenceKeys: sentReferences.map((reference) => reference.key) }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        jobId?: string;
        pointsReserved?: number;
        error?: string;
      };
      if (response.status !== 202 || !body.jobId) {
        setFormError(body.error ?? "We couldn't start your edit. Please try again.");
        void refreshPoints();
        return;
      }
      const reserved = body.pointsReserved ?? cost;
      setJob({
        id: body.jobId,
        pointsReserved: reserved,
        parentVersion: current.version,
        instruction: text,
      });
      setInstruction('');
      setReferences([]);
      setPoints((value) => ({ ...value, left: Math.max(0, value.left - reserved) }));
    } catch {
      setFormError('Something went wrong. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const refunded = job ? job.pointsReserved - (poll.job?.pointsCharged ?? 0) : 0;

  return (
    <div className="edit-panel">
      <div className="generate-heading">
        <h1>Edit image</h1>
        <p className="points-display" aria-live="polite">
          {points.left} of {points.limit} points left today
        </p>
        <Link href={GENERATE_PATH}>Create a new image</Link>
      </div>

      <div className="edit-layout">
        <section className="edit-viewer" aria-labelledby="viewer-heading">
          <h2 id="viewer-heading">Version {current.version}</h2>
          {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
          <img
            src={current.url}
            alt={versionAltText(current)}
            width={current.width}
            height={current.height}
          />
          <div className="result-actions">
            <a className="button" href={downloadPath(imageId, current.version)} download>
              Download PNG
            </a>
            <ReportImage imageId={imageId} version={current.version} />
          </div>
        </section>

        <section className="edit-history" aria-labelledby="versions-heading">
          <h2 id="versions-heading">Versions</h2>
          {/* Capped near the viewer's height, so many versions scroll here instead of down the page. */}
          <ol
            data-slot="version-list"
            aria-label="Versions"
            className="m-0 flex max-h-[min(520px,70vh)] list-none flex-col gap-2 overflow-y-auto p-1"
          >
            {versions.map((version) => (
              <VersionCard
                key={version.version}
                version={version}
                selected={version.version === current.version}
                onSelect={setSelected}
              />
            ))}
            {job && jobActive && (
              <li
                data-slot="version-pending"
                role="status"
                className="flex flex-col rounded-lg border border-dashed border-primary p-2 text-sm"
              >
                <span className="font-semibold">{STATUS_LABELS[status ?? 'queued']}…</span>
                <span className="max-h-20 overflow-y-auto break-words whitespace-pre-wrap">
                  {job.instruction}
                </span>
                <span className="text-xs text-muted-foreground">
                  From version {job.parentVersion}
                </span>
              </li>
            )}
          </ol>
          {poll.timedOut && (
            <p className="job-note">
              This is taking longer than usual. Refresh the page later to see the new version.
            </p>
          )}
          {poll.lost && (
            <p className="form-error" role="alert">
              We can&apos;t follow this edit any more. Refresh the page to check on it.
            </p>
          )}
          {jobFailed && (
            <div className="job-failure" role="alert">
              <p>{poll.job?.error ?? 'Something went wrong while editing your image.'}</p>
              {refunded > 0 && <p>{pointsText(refunded)} returned to your allowance.</p>}
            </div>
          )}
          {refreshError && (
            <p className="form-error" role="alert">
              {refreshError}
            </p>
          )}
        </section>
      </div>

      <form className="generate-form edit-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="field">
          <label htmlFor="instruction">Describe your change</label>
          <textarea
            id="instruction"
            rows={3}
            maxLength={MAX_PROMPT_LENGTH}
            value={instruction}
            placeholder="For example: make it night, add stars"
            aria-describedby="instruction-hint"
            onChange={(event) => setInstruction(event.target.value)}
          />
          <span id="instruction-hint" className="field-hint">
            Edits version {current.version}. Earlier versions are always kept.
          </span>
        </div>

        <div className="field">
          <label htmlFor="edit-model">Model</label>
          <select
            id="edit-model"
            value={model.id}
            onChange={(event) => {
              const next = available.find((candidate) => candidate.id === event.target.value);
              if (next) chooseModel(next);
            }}
          >
            {available.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName}
              </option>
            ))}
          </select>
          <span className="field-hint">{model.strengths.join(', ')}</span>
        </div>

        <fieldset className="quality-picker">
          <legend>Quality</legend>
          {premiumPausedUntil && (
            <p className="form-notice" role="status">
              {premiumPausedText(premiumPausedUntil)}
            </p>
          )}
          {QUALITIES.map((option) => {
            const perImage = costPerImage(model, option);
            const paused = qualityPaused(model, option);
            return (
              <label key={option} className="option-card">
                <input
                  type="radio"
                  name="quality"
                  value={option}
                  checked={quality === option}
                  disabled={perImage === undefined || paused}
                  onChange={() => setQuality(option)}
                />
                <span>{QUALITY_LABELS[option]}</span>
                <span className="field-hint">
                  {perImage === undefined
                    ? `Not offered by ${model.displayName}`
                    : paused
                      ? 'Paused this month'
                      : pointsText(perImage)}
                </span>
              </label>
            );
          })}
        </fieldset>

        {allowedReferences > 0 && (
          <fieldset className="reference-picker">
            <legend>Reference images (optional)</legend>
            <p className="field-hint">
              Up to {allowedReferences} images for style or subject. Uploads are checked against our
              content policy.
            </p>
            {sentReferences.length > 0 && (
              <ul className="reference-list" aria-label="Reference images">
                {sentReferences.map((reference, index) => (
                  <li key={reference.key}>
                    <span>{reference.name}</span>
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`Remove ${reference.name}`}
                      onClick={() => setReferences((list) => list.filter((_, at) => at !== index))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="result-actions">
              <button
                type="button"
                className="button"
                disabled={busy || sentReferences.length >= allowedReferences}
                onClick={() => referenceInput.current?.click()}
              >
                Upload reference
              </button>
              <button
                type="button"
                className="button"
                disabled={sentReferences.length >= allowedReferences}
                onClick={() => setPicking(true)}
              >
                Choose from gallery
              </button>
            </div>
            <input
              ref={referenceInput}
              type="file"
              accept={UPLOAD_ACCEPT}
              className="visually-hidden"
              aria-label="Choose a reference image to upload"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared, so picking the same file again still uploads it.
                event.target.value = '';
                if (file) void addReference(file);
              }}
            />
            {referenceStatus && (
              <p className="upload-progress" role="status">
                {referenceStatus}
              </p>
            )}
            {referenceError && (
              <p className="form-error" role="alert">
                {referenceError}
              </p>
            )}
          </fieldset>
        )}

        <div className="generate-submit">
          <p id="edit-cost" className="cost-display">
            Uses {cost} of your {points.left} points today
          </p>
          {!affordable && (
            <p className="form-error">
              You don&apos;t have enough points left today. Pick a lower quality, or come back after
              00:00 UTC.
            </p>
          )}
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <button
            type="submit"
            className="button button-primary"
            disabled={!affordable || busy}
            aria-describedby="edit-cost"
          >
            {submitting ? 'Starting…' : jobActive ? 'Editing…' : 'Apply edit'}
          </button>
        </div>
      </form>
      {picking && <GalleryPicker onPick={pickReference} onClose={() => setPicking(false)} />}
    </div>
  );
}
