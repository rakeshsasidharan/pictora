'use client';

import { TERMINAL_JOB_STATUSES } from '@pictora/core';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { BATCH_POLL_TIMEOUT_MS } from '../lib/generate_options';
import type { JobStatusBody } from '../lib/jobs';
import { useJobStatus } from '../lib/use_job_status';
import { JobProgress } from './job_progress';

/** One request in the generate thread: the prompt as sent, with its options, and the job it started. */
export interface GenerateTurn {
  jobId: string;
  prompt: string;
  /** The options chosen for it, such as the style, aspect and quality, shown as chips. */
  options: string[];
  pointsReserved: number;
  /** The model the job runs on, which Auto picks on the server. */
  modelId: string;
  modelName: string;
  count: number;
  /** Delivered later through a provider batch, at half the points (tech design 5.4). */
  batch: boolean;
}

export interface GenerateTurnViewProps {
  turn: GenerateTurn;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  batchPollIntervalMs: number;
  /** Called once when the job reaches a final status. */
  onFinish: (job: JobStatusBody) => void;
  /** Called once the screen stops following the job: finished, timed out or lost. */
  onEnd: (jobId: string) => void;
}

/**
 * A turn of the thread: the prompt and its options on the right, like a sent message, then the job's live
 * status and results (GEN-8). It follows its own job, so earlier batch jobs keep updating while new ones run,
 * and scrolls itself into view when it is added.
 */
export function GenerateTurnView({
  turn,
  pollIntervalMs,
  pollTimeoutMs,
  batchPollIntervalMs,
  onFinish,
  onEnd,
}: GenerateTurnViewProps) {
  const item = useRef<HTMLLIElement>(null);
  const poll = useJobStatus(turn.jobId, {
    intervalMs: turn.batch ? batchPollIntervalMs : pollIntervalMs,
    timeoutMs: turn.batch ? BATCH_POLL_TIMEOUT_MS : pollTimeoutMs,
    onFinish,
  });
  const ended =
    poll.timedOut ||
    poll.lost ||
    (poll.job !== undefined && TERMINAL_JOB_STATUSES.includes(poll.job.status));

  useEffect(() => {
    item.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    if (ended) onEnd(turn.jobId);
  }, [ended, onEnd, turn.jobId]);

  return (
    <li ref={item} className="flex scroll-mt-16 flex-col gap-3">
      <div className="ml-auto flex max-w-[85%] flex-col items-end gap-2">
        <p className="rounded-2xl bg-muted px-4 py-2 break-words whitespace-pre-wrap">
          {turn.prompt}
        </p>
        <ul aria-label="Options" className="flex flex-wrap justify-end gap-1">
          {turn.options.map((option) => (
            <li key={option}>
              <Badge variant="outline">{option}</Badge>
            </li>
          ))}
        </ul>
      </div>
      <JobProgress
        poll={poll}
        pointsReserved={turn.pointsReserved}
        prompt={turn.prompt}
        batch={turn.batch}
        count={turn.count}
        modelName={turn.modelName}
      />
    </li>
  );
}
