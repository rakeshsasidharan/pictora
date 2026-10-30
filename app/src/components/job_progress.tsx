'use client';

import { DownloadIcon, Loader2Icon, PencilIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
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
  /** How many images were asked for, shown as placeholders while they are made. */
  count?: number;
}

const STEPS = ['queued', 'running', 'succeeded'] as const;
const BATCH_STEPS = ['scheduled', 'succeeded'] as const;

const GALLERY_LINK_CLASS = 'font-medium text-foreground underline underline-offset-4';

/** What a step is called; a batch job is Scheduled while it waits for or sits in its provider batch. */
function stepIndex(steps: readonly string[], status: string): number {
  const shown = status === 'submitted' ? 'scheduled' : status;
  return steps.indexOf(shown);
}

/** A step's badge: done steps are muted, the current one solid, a failed last step red, later ones outlined. */
function stepVariant(
  index: number,
  current: number,
  failedStep: boolean,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (index < current) return 'secondary';
  if (index > current) return 'outline';
  return failedStep ? 'destructive' : 'default';
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
  count = 1,
}: JobProgressProps) {
  const headingId = useId();
  const { job, timedOut, lost } = poll;
  const status = job?.status ?? (batch ? 'scheduled' : 'queued');
  const steps: readonly JobStatusBody['status'][] = batch ? BATCH_STEPS : STEPS;
  const failed = status === 'failed' || status === 'blocked';
  const active = !failed && status !== 'succeeded' && !timedOut && !lost;
  const current = failed ? steps.length - 1 : stepIndex(steps, status);
  const refunded = pointsReserved - (job?.pointsCharged ?? 0);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4">
      <h2 id={headingId} className="sr-only">
        Your images
      </h2>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <ol aria-label="Progress" className="flex flex-wrap items-center gap-1">
          {steps.map((step, index) => {
            const last = index === steps.length - 1;
            const label = last && failed ? STATUS_LABELS[status] : STATUS_LABELS[step];
            return (
              <li key={step} aria-current={index === current ? 'step' : undefined}>
                <Badge variant={stepVariant(index, current, last && failed)}>{label}</Badge>
              </li>
            );
          })}
        </ol>
        <p role="status" className="flex items-center gap-1.5 font-medium">
          {active && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
          Status: {STATUS_LABELS[status]}
        </p>
        <p className="text-muted-foreground">Model: {modelName}</p>
      </div>

      {active && batch && (
        <p className="text-sm text-muted-foreground">
          Your images will be in your{' '}
          <Link href={GALLERY_PATH} className={GALLERY_LINK_CLASS}>
            gallery
          </Link>{' '}
          within 24 hours, often much sooner. You can leave this page.
        </p>
      )}
      {batch && (active || status === 'succeeded') && (
        <ReadyNotification ready={status === 'succeeded'} prompt={prompt} />
      )}
      {active && !batch && (
        <>
          <p className="text-sm text-muted-foreground">
            You can leave this page; your images will be saved to your{' '}
            <Link href={GALLERY_PATH} className={GALLERY_LINK_CLASS}>
              gallery
            </Link>
            .
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
            {Array.from({ length: count }, (_, index) => (
              <Skeleton key={index} className="aspect-square w-full rounded-lg" />
            ))}
          </div>
        </>
      )}
      {timedOut && (
        <p className="text-sm text-muted-foreground">
          This is taking longer than usual. Your images will be in your{' '}
          <Link href={GALLERY_PATH} className={GALLERY_LINK_CLASS}>
            gallery
          </Link>{' '}
          when they are ready.
        </p>
      )}
      {lost && (
        <p className="text-sm text-destructive" role="alert">
          We can&apos;t show this job any more. Refresh the page to check your points.
        </p>
      )}
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{job?.error ?? 'Something went wrong while creating your images.'}</p>
            {refunded > 0 && <p>{pointsText(refunded)} returned to your allowance.</p>}
          </AlertDescription>
        </Alert>
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
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="self-start"
      onClick={() => void ask()}
    >
      Notify me when they&apos;re ready
    </Button>
  );
}

function ResultsGrid({ images, prompt }: { images: JobImage[]; prompt: string }) {
  const [viewing, setViewing] = useState<JobImage>();
  const alt = altTextFor(prompt);

  return (
    <>
      <ul aria-label="Results" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((image, index) => (
          <li key={`${image.imageId}-${image.version}`} className="flex flex-col gap-2">
            <Button
              type="button"
              variant="ghost"
              aria-label={`View image ${index + 1} full size`}
              className="h-auto cursor-zoom-in overflow-hidden rounded-lg border bg-muted p-0"
              onClick={() => setViewing(image)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
              <img
                src={image.url}
                alt={alt}
                className="h-auto w-full"
                onLoad={() => void reportFirstImage()}
              />
            </Button>
            <div className="flex flex-wrap gap-1">
              <Button asChild variant="outline" size="sm">
                <a href={downloadPath(image.imageId, image.version)} download>
                  <DownloadIcon aria-hidden="true" />
                  Download PNG
                </a>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href={editImagePath(image.imageId, image.version)}>
                  <PencilIcon aria-hidden="true" />
                  Edit
                </Link>
              </Button>
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
  const close = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          // Close takes the focus, so Escape and Enter work straight away.
          event.preventDefault();
          close.current?.focus();
        }}
        showCloseButton={false}
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-3xl"
      >
        <DialogTitle className="sr-only">Full-size image</DialogTitle>
        {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
        <img src={image.url} alt={alt} className="max-h-[70svh] w-full rounded-md object-contain" />
        <div className="flex flex-wrap items-start gap-2">
          <Button asChild>
            <a href={downloadPath(image.imageId, image.version)} download>
              <DownloadIcon aria-hidden="true" />
              Download PNG
            </a>
          </Button>
          <Button ref={close} type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          <ReportImage imageId={image.imageId} version={image.version} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
