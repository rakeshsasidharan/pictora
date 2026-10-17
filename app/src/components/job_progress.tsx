'use client';

import { useState, type KeyboardEvent } from 'react';
import { COMING_SOON, type ComingSoonFeature } from '../lib/coming_soon';
import { STATUS_LABELS, altTextFor, pointsText } from '../lib/generate_options';
import type { JobStatusBody } from '../lib/jobs';
import type { JobPoll } from '../lib/use_job_status';

type JobImage = NonNullable<JobStatusBody['images']>[number];

export interface JobProgressProps {
  poll: JobPoll;
  /** Points reserved when the job was created. */
  pointsReserved: number;
  /** The prompt the job was made from, used as the images' alt text. */
  prompt: string;
  onComingSoon: (feature: ComingSoonFeature) => void;
}

const STEPS = ['queued', 'running', 'succeeded'] as const;

/**
 * A submitted job: its status as queued, generating and done (GEN-8), then the results with a full-size view
 * and PNG download (GEN-7), or the reason it failed and the refund (GEN-10).
 */
export function JobProgress({ poll, pointsReserved, prompt, onComingSoon }: JobProgressProps) {
  const { job, timedOut, lost } = poll;
  const status = job?.status ?? 'queued';
  const failed = status === 'failed' || status === 'blocked';
  const active = !failed && status !== 'succeeded' && !timedOut && !lost;
  const current = failed ? 2 : STEPS.indexOf(status as (typeof STEPS)[number]);
  const refunded = pointsReserved - (job?.pointsCharged ?? 0);

  return (
    <section className="job-progress" aria-labelledby="job-heading">
      <h2 id="job-heading">Your images</h2>
      <ol className="job-steps">
        {STEPS.map((step, index) => {
          const label = index === 2 && failed ? STATUS_LABELS[status] : STATUS_LABELS[step];
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

      {active && (
        <p className="job-note">
          You can leave this page; your images will be saved to your{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => onComingSoon(COMING_SOON.gallery)}
          >
            gallery
          </button>
          .
        </p>
      )}
      {timedOut && (
        <p className="job-note">
          This is taking longer than usual. Your images will be in your gallery when they are ready.
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
      {status === 'succeeded' && job?.images && (
        <ResultsGrid images={job.images} prompt={prompt} onComingSoon={onComingSoon} />
      )}
    </section>
  );
}

function ResultsGrid({
  images,
  prompt,
  onComingSoon,
}: {
  images: JobImage[];
  prompt: string;
  onComingSoon: (feature: ComingSoonFeature) => void;
}) {
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
              <img src={image.url} alt={alt} />
            </button>
            <div className="result-actions">
              <a className="button" href={image.downloadUrl} download>
                Download PNG
              </a>
              <button
                type="button"
                className="button"
                onClick={() => onComingSoon(COMING_SOON.edit)}
              >
                Edit
              </button>
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
        <a className="button button-primary" href={image.downloadUrl} download>
          Download PNG
        </a>
        {/* Focused on open, so Escape and Enter work straight away. */}
        <button type="button" className="button" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
    </div>
  );
}
