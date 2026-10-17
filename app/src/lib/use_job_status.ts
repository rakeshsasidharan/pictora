'use client';

import { TERMINAL_JOB_STATUSES } from '@pictora/core';
import { useEffect, useRef, useState } from 'react';
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from './generate_options';
import type { JobStatusBody } from './jobs';

/** What the screen knows about a job it is following. */
export interface JobPoll {
  /** The latest `GET /api/jobs/:id` answer. */
  job?: JobStatusBody;
  /** True once polling stopped after the timeout without a final status. */
  timedOut: boolean;
  /** True when the job can no longer be read (404, or the session ended). */
  lost: boolean;
}

export interface JobPollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Called once with the job when it reaches a final status. */
  onFinish?: (job: JobStatusBody) => void;
}

const IDLE: JobPoll = { timedOut: false, lost: false };

/**
 * Follows a job (GEN-8): asks `GET /api/jobs/:id` every 2 s until it succeeds, fails or is blocked, or for
 * 3 minutes. Network errors are retried until then. Polling stops when the component unmounts, which is
 * safe: the job carries on in the background.
 */
export function useJobStatus(jobId: string | undefined, options: JobPollOptions = {}): JobPoll {
  const { intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS, onFinish } = options;
  const [state, setState] = useState<JobPoll & { jobId?: string }>(IDLE);
  const onFinishRef = useRef(onFinish);
  useEffect(() => {
    onFinishRef.current = onFinish;
  });

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const update = (next: Partial<JobPoll>) =>
      setState((previous) => ({
        ...(previous.jobId === jobId ? previous : IDLE),
        ...next,
        jobId,
      }));

    async function poll() {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId!)}`, {
          cache: 'no-store',
        });
        if (cancelled) return;
        if (response.ok) {
          const job = (await response.json()) as JobStatusBody;
          if (cancelled) return;
          update({ job });
          if (TERMINAL_JOB_STATUSES.includes(job.status)) {
            onFinishRef.current?.(job);
            return;
          }
        } else if (response.status === 401 || response.status === 404) {
          update({ lost: true });
          return;
        }
      } catch {
        // A dropped connection: try again on the next tick.
      }
      if (cancelled) return;
      if (Date.now() - started >= timeoutMs) {
        update({ timedOut: true });
        return;
      }
      timer = setTimeout(poll, intervalMs);
    }

    timer = setTimeout(poll, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, intervalMs, timeoutMs]);

  if (!jobId || state.jobId !== jobId) return IDLE;
  return { job: state.job, timedOut: state.timedOut, lost: state.lost };
}
