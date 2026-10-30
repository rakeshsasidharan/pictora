'use client';

import { TERMINAL_JOB_STATUSES, type GenerateJobRequest, type Quality } from '@pictora/core';
import { PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { BATCH_POLL_TIMEOUT_MS, pointsText } from '../lib/generate_options';
import type { JobStatusBody } from '../lib/jobs';
import { scrollBehavior } from '../lib/motion';
import { useJobStatus } from '../lib/use_job_status';
import { JobProgress } from './job_progress';

/** One request in the generate thread: the prompt as sent, with its options, and the job it started. */
export interface GenerateTurn {
  jobId: string;
  prompt: string;
  /** The main options (style, aspect, quality, variations, model), shown as one line under the prompt. */
  summary: string[];
  /** Options set less often (transparent background, avoid, enhanced, delivered later), shown on request. */
  extras: string[];
  /** The request as sent, which "More variations" sends again on the model it ran on. */
  request: GenerateJobRequest;
  /** The quality it ran at, which Auto may have lowered to fit the points left. */
  quality: Quality;
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
  /** "More variations": the same request again. Disabled while another job runs or the points don't cover it. */
  onMoreVariations: (turn: GenerateTurn) => void;
  moreVariationsDisabled: boolean;
  /** Shown under the prompt, such as the editable enhanced prompt on the latest turn. */
  children?: ReactNode;
}

/**
 * A turn of the thread: the prompt on the right, like a sent message, with its options as one muted line and the
 * rarer ones behind Details, then the job's live status and results (GEN-8) and, once done, "More variations". It
 * follows its own job, so earlier batch jobs keep updating while new ones run, and scrolls itself into view when
 * it is added.
 */
export function GenerateTurnView({
  turn,
  pollIntervalMs,
  pollTimeoutMs,
  batchPollIntervalMs,
  onFinish,
  onEnd,
  onMoreVariations,
  moreVariationsDisabled,
  children,
}: GenerateTurnViewProps) {
  const item = useRef<HTMLLIElement>(null);
  const [showExtras, setShowExtras] = useState(false);
  const poll = useJobStatus(turn.jobId, {
    intervalMs: turn.batch ? batchPollIntervalMs : pollIntervalMs,
    timeoutMs: turn.batch ? BATCH_POLL_TIMEOUT_MS : pollTimeoutMs,
    onFinish,
  });
  const ended =
    poll.timedOut ||
    poll.lost ||
    (poll.job !== undefined && TERMINAL_JOB_STATUSES.includes(poll.job.status));
  const succeeded = poll.job?.status === 'succeeded' && (poll.job.images?.length ?? 0) > 0;

  useEffect(() => {
    item.current?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'start' });
  }, []);

  useEffect(() => {
    if (ended) onEnd(turn.jobId);
  }, [ended, onEnd, turn.jobId]);

  return (
    <li ref={item} className="flex scroll-mt-16 flex-col gap-3">
      <Collapsible asChild open={showExtras} onOpenChange={setShowExtras}>
        <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
          <p className="rounded-2xl bg-muted px-4 py-2 wrap-break-word whitespace-pre-wrap">
            {turn.prompt}
          </p>
          <div className="flex flex-wrap items-baseline justify-end gap-x-2 text-xs text-muted-foreground">
            <p data-slot="turn-summary">{turn.summary.join(' · ')}</p>
            {turn.extras.length > 0 && (
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto p-0 text-xs text-muted-foreground"
                >
                  {showExtras ? 'Hide details' : 'Details'}
                </Button>
              </CollapsibleTrigger>
            )}
          </div>
          {turn.extras.length > 0 && (
            <CollapsibleContent asChild>
              <p className="text-right text-xs wrap-break-word text-muted-foreground">
                {turn.extras.join(' · ')}
              </p>
            </CollapsibleContent>
          )}
        </div>
      </Collapsible>
      {children}
      <JobProgress
        poll={poll}
        pointsReserved={turn.pointsReserved}
        prompt={turn.prompt}
        batch={turn.batch}
        count={turn.count}
        modelName={turn.modelName}
      />
      {succeeded && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={moreVariationsDisabled}
          onClick={() => onMoreVariations(turn)}
        >
          <PlusIcon aria-hidden="true" />
          More variations · {pointsText(turn.pointsReserved)}
        </Button>
      )}
    </li>
  );
}
