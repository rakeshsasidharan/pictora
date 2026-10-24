'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { STATUS_LABELS, altTextFor, pointsText } from '../lib/generate_options';
import type { JobStatusBody } from '../lib/jobs';
import { reportFirstImage } from '../lib/first_image';
import { GALLERY_PATH, downloadPath, editImagePath } from '../lib/site';
import type { JobPoll } from '../lib/use_job_status';
import { ReportImage } from './report_image';

type JobImage = NonNullable<JobStatusBody['images']>[number];

export interface JobProgressProps {
  poll: JobPoll;
  /** Points reserved when the job was created. */
  pointsReserved: number;
  /** The prompt the job was made from, used as the images' alt text. */
  prompt: string;
  /** The model the images are made with, which Auto may have picked. */
  modelName: string;
  /** A batch job, delivered later (tech design 5.4): scheduled, then done. */
  batch?: boolean;
}

const STEPS = ['queued', 'running', 'succeeded'] as const;
const BATCH_STEPS = ['scheduled', 'succeeded'] as const;

/** What a step is called; a batch job is Scheduled while it waits for or sits in its provider batch. */
function stepIndex(steps: readonly string[], status: string): number {
  const shown = status === 'submitted' ? 'scheduled' : status;
  return steps.indexOf(shown);
}

/**
 * A submitted job: its status as queued, generating and done (GEN-8), then the results with a full-size view,
 * PNG download (GEN-7) and a Report action, or the reason it failed and the refund (GEN-10).
 */
export function JobProgress({
  poll,
  pointsReserved,
  prompt,
  modelName,
  batch = false,
}: JobProgressProps) {
  const { job, timedOut, lost } = poll;
  const status = job?.status ?? (batch ? 'scheduled' : 'queued');
  const steps: readonly JobStatusBody['status'][] = batch ? BATCH_STEPS : STEPS;
  const failed = status === 'failed' || status === 'blocked';
  const active = !failed && status !== 'succeeded' && !timedOut && !lost;
  const current = failed ? steps.length - 1 : stepIndex(steps, status);
  const refunded = pointsReserved - (job?.pointsCharged ?? 0);

  return (
    <section className="job-progress" aria-labelledby="job-heading">
      <h2 id="job-heading">Your images</h2>
      <ol className="job-steps">
        {steps.map((step, index) => {
          const label =
            index === steps.length - 1 && failed ? STATUS_LABELS[status] : STATUS_LABELS[step];
          return (
            <li
              key={step}
              className={index < current ? 'step-done' : index === current ? 'step-current' : ''}
              aria-current={index === current ? 'step' : undefined}
            >
              {label}
            </li>
          );
        })}
      </ol>
      <p className="job-status" role="status">
        Status: {STATUS_LABELS[status]}
      </p>
      <p className="job-model">Model: {modelName}</p>

      {active && batch && (
        <p className="job-note">
          Your images will be in your <Link href={GALLERY_PATH}>gallery</Link> within 24 hours,
          often much sooner. You can leave this page.
        </p>
      )}
      {batch && (active || status === 'succeeded') && (
        <ReadyNotification ready={status === 'succeeded'} prompt={prompt} />
      )}
      {active && !batch && (
        <p className="job-note">
          You can leave this page; your images will be saved to your{' '}
          <Link href={GALLERY_PATH}>gallery</Link>.
        </p>
      )}
      {timedOut && (
        <p className="job-note">
          This is taking longer than usual. Your images will be in your{' '}
          <Link href={GALLERY_PATH}>gallery</Link> when they are ready.
        </p>
      )}
      {lost && (
        <p className="form-error" role="alert">
          We can&apos;t show this job any more. Refresh the page to check your points.
        </p>
      )}
      {failed && (
        <div className="job-failure" role="alert">
          <p>{job?.error ?? 'Something went wrong while creating your images.'}</p>
          {refunded > 0 && <p>{pointsText(refunded)} returned to your allowance.</p>}
        </div>
      )}
      {status === 'succeeded' && job?.images && <ResultsGrid images={job.images} prompt={prompt} />}
    </section>
  );
}

/** Whether the browser can show notifications at all. */
function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * The optional "tell me when it's ready" for a batch job (tech design 5.4): asks for the browser's permission,
 * then shows a notification when the job is done, as long as this page stays open. Renders nothing once
 * the images are ready, or where notifications are unsupported or blocked.
 */
function ReadyNotification({ ready, prompt }: { ready: boolean; prompt: string }) {
  const [wanted, setWanted] = useState(false);
  const [denied, setDenied] = useState(
    () => notificationsSupported() && Notification.permission === 'denied',
  );
  const shown = useRef(false);

  useEffect(() => {
    if (!ready || !wanted || shown.current || !notificationsSupported()) return;
    shown.current = true;
    new Notification('Your Pictora images are ready', { body: prompt, tag: 'pictora-batch' });
  }, [ready, wanted, prompt]);

  if (ready || !notificationsSupported() || denied) return null;
  if (wanted) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        We&apos;ll notify you here when your images are ready, while this page stays open.
      </p>
    );
  }

  async function ask() {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') setWanted(true);
    else setDenied(true);
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void ask()}>
      Notify me when they&apos;re ready
    </Button>
  );
}

function ResultsGrid({ images, prompt }: { images: JobImage[]; prompt: string }) {
  const [viewing, setViewing] = useState<JobImage>();
  const alt = altTextFor(prompt);

  return (
    <>
      <ul className="results-grid" aria-label="Results">
        {images.map((image, index) => (
          <li key={`${image.imageId}-${image.version}`}>
            <button
              type="button"
              className="result-image"
              aria-label={`View image ${index + 1} full size`}
              onClick={() => setViewing(image)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
              <img src={image.url} alt={alt} onLoad={() => void reportFirstImage()} />
            </button>
            <div className="result-actions">
              <a className="button" href={downloadPath(image.imageId, image.version)} download>
                Download PNG
              </a>
              <Link className="button" href={editImagePath(image.imageId, image.version)}>
                Edit
              </Link>
            </div>
          </li>
        ))}
      </ul>
      {viewing && <FullSizeView image={viewing} alt={alt} onClose={() => setViewing(undefined)} />}
    </>
  );
}

function FullSizeView({
  image,
  alt,
  onClose,
}: {
  image: JobImage;
  alt: string;
  onClose: () => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') onClose();
  }

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Full-size image"
      onKeyDown={onKeyDown}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
      <img src={image.url} alt={alt} />
      <div className="result-actions">
        <a
          className="button button-primary"
          href={downloadPath(image.imageId, image.version)}
          download
        >
          Download PNG
        </a>
        {/* Focused on open, so Escape and Enter work straight away. */}
        <button type="button" className="button" onClick={onClose} autoFocus>
          Close
        </button>
        <ReportImage imageId={image.imageId} version={image.version} />
      </div>
    </div>
  );
}
