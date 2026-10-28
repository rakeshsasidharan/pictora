'use client';

import { METRIC_IDS, meetsTarget, type MetricId, type MetricTarget } from '@pictora/core';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { AdminMetricsBody, MetricsDay } from '../lib/admin_metrics';
import { METRIC_LABELS, formatMetric, formatTarget } from '../lib/metrics_format';
import { ADMIN_CAPTION_CLASS, NUMBER_CLASS, TILE_GRID_CLASS } from './admin_parts';

type MetricsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; metrics: AdminMetricsBody };

/** A metric's value on a day, or over the period; null when there is nothing to measure yet. */
function dayValue(day: MetricsDay, metric: MetricId): number | null {
  return day[metric]?.value ?? null;
}

function periodValue(metrics: AdminMetricsBody, metric: MetricId): number | null {
  return metrics.period[metric].value;
}

/**
 * The PRD's success metrics on the admin dashboard (tech design 11.1): each metric over the chosen range (set it
 * to the beta dates to judge the beta) against its target, then day by day. Met targets are green and missed ones
 * red, always with the words too.
 */
export function SuccessMetrics({ range }: { range: { from?: string; to?: string } }) {
  const [state, setState] = useState<MetricsState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    void (async () => {
      try {
        const response = await fetch(`/api/admin/metrics${query}`, { cache: 'no-store' });
        const body = (await response.json().catch(() => ({}))) as AdminMetricsBody & {
          error?: string;
        };
        if (cancelled) return;
        if (!response.ok) {
          setState({ phase: 'error', message: body.error ?? "We couldn't load the metrics." });
          return;
        }
        setState({ phase: 'ready', metrics: body });
      } catch {
        if (!cancelled) setState({ phase: 'error', message: "We couldn't load the metrics." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="metrics-heading">
      <h2 id="metrics-heading" className="text-lg font-semibold">
        Success metrics
      </h2>
      {state.phase === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading metrics…
        </p>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      {state.phase === 'ready' && <MetricsView metrics={state.metrics} />}
    </section>
  );
}

function MetricsView({ metrics }: { metrics: AdminMetricsBody }) {
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {metrics.from} to {metrics.to}. Computed each day after midnight UTC
        {metrics.computedAt
          ? `, last at ${metrics.computedAt.slice(0, 16).replace('T', ' ')} UTC`
          : ''}
        . Keep rate and week-1 retention are known 8 days after the day.
      </p>
      <ul className={TILE_GRID_CLASS} aria-label="Success metrics over the range">
        {METRIC_IDS.map((metric) => (
          <MetricTile
            key={metric}
            metric={metric}
            value={periodValue(metrics, metric)}
            target={metrics.targets[metric]}
          />
        ))}
      </ul>
      <Table className="tabular-nums">
        <TableCaption className={ADMIN_CAPTION_CLASS}>Success metrics by day</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Day</TableHead>
            {METRIC_IDS.map((metric) => (
              <TableHead key={metric} scope="col" className={NUMBER_CLASS}>
                {METRIC_LABELS[metric]}
                <span className="font-normal text-muted-foreground">
                  {' '}
                  {formatTarget(metric, metrics.targets[metric])}
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {metrics.days.map((day) => (
            <TableRow key={day.date}>
              <TableHead scope="row">{day.date}</TableHead>
              {METRIC_IDS.map((metric) =>
                day.computed ? (
                  <MetricCell
                    key={metric}
                    metric={metric}
                    value={dayValue(day, metric)}
                    target={metrics.targets[metric]}
                  />
                ) : (
                  <TableCell
                    key={metric}
                    data-status="pending"
                    className={cn(NUMBER_CLASS, 'text-muted-foreground')}
                  >
                    Pending
                  </TableCell>
                ),
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

type Status = 'met' | 'missed' | 'none';

function status(value: number | null, target: MetricTarget): Status {
  if (value === null) return 'none';
  return meetsTarget(target, value) ? 'met' : 'missed';
}

const STATUS_TEXT: Record<Status, string> = {
  met: 'Meets target',
  missed: 'Misses target',
  none: 'No data yet',
};

/** Met targets are green and missed ones red, in both themes; the words always say it too. */
const STATUS_TEXT_CLASS: Record<Status, string> = {
  met: 'text-green-700 dark:text-green-400',
  missed: 'text-destructive',
  none: 'text-muted-foreground',
};

const STATUS_BORDER_CLASS: Record<Status, string> = {
  met: 'border-l-4 border-l-green-600 dark:border-l-green-400',
  missed: 'border-l-4 border-l-destructive',
  none: '',
};

function MetricTile({
  metric,
  value,
  target,
}: {
  metric: MetricId;
  value: number | null;
  target: MetricTarget;
}) {
  const result = status(value, target);
  return (
    <li data-testid={`metric-${metric}`} data-status={result}>
      <Card className={cn('h-full gap-1 py-4', STATUS_BORDER_CLASS[result])}>
        <CardHeader className="gap-1 px-4">
          <CardDescription>{METRIC_LABELS[metric]}</CardDescription>
          <CardTitle className="text-2xl font-bold tabular-nums">
            {value === null ? '—' : formatMetric(metric, value)}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 text-sm text-muted-foreground">
          Target {formatTarget(metric, target)} ·{' '}
          <strong className={STATUS_TEXT_CLASS[result]}>{STATUS_TEXT[result]}</strong>
        </CardContent>
      </Card>
    </li>
  );
}

function MetricCell({
  metric,
  value,
  target,
}: {
  metric: MetricId;
  value: number | null;
  target: MetricTarget;
}) {
  const result = status(value, target);
  if (value === null) {
    return (
      <TableCell data-status="none" className={cn(NUMBER_CLASS, STATUS_TEXT_CLASS.none)}>
        —
      </TableCell>
    );
  }
  return (
    <TableCell data-status={result} className={cn(NUMBER_CLASS, STATUS_TEXT_CLASS[result])}>
      {formatMetric(metric, value)}
      <span className="sr-only">, {STATUS_TEXT[result].toLowerCase()}</span>
    </TableCell>
  );
}
