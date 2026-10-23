'use client';

import { METRIC_IDS, meetsTarget, type MetricId, type MetricTarget } from '@pictora/core';
import { useEffect, useState } from 'react';
import type { AdminMetricsBody, MetricsDay } from '../lib/admin_metrics';
import { METRIC_LABELS, formatMetric, formatTarget } from '../lib/metrics_format';

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
    <section className="success-metrics" aria-labelledby="metrics-heading">
      <h2 id="metrics-heading">Success metrics</h2>
      {state.phase === 'loading' && (
        <p role="status" className="admin-note">
          Loading metrics…
        </p>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="form-error">
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
      <p className="admin-note">
        {metrics.from} to {metrics.to}. Computed each day after midnight UTC
        {metrics.computedAt
          ? `, last at ${metrics.computedAt.slice(0, 16).replace('T', ' ')} UTC`
          : ''}
        . Keep rate and week-1 retention are known 8 days after the day.
      </p>
      <ul className="kpi-tiles" aria-label="Success metrics over the range">
        {METRIC_IDS.map((metric) => (
          <MetricTile
            key={metric}
            metric={metric}
            value={periodValue(metrics, metric)}
            target={metrics.targets[metric]}
          />
        ))}
      </ul>
      <div className="table-scroll">
        <table className="admin-table">
          <caption>Success metrics by day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {METRIC_IDS.map((metric) => (
                <th key={metric} scope="col">
                  {METRIC_LABELS[metric]}
                  <span className="field-hint">
                    {' '}
                    {formatTarget(metric, metrics.targets[metric])}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.days.map((day) => (
              <tr key={day.date}>
                <th scope="row">{day.date}</th>
                {METRIC_IDS.map((metric) =>
                  day.computed ? (
                    <MetricCell
                      key={metric}
                      metric={metric}
                      value={dayValue(day, metric)}
                      target={metrics.targets[metric]}
                    />
                  ) : (
                    <td key={metric} className="metric-pending">
                      Pending
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function status(value: number | null, target: MetricTarget): 'met' | 'missed' | 'none' {
  if (value === null) return 'none';
  return meetsTarget(target, value) ? 'met' : 'missed';
}

const STATUS_TEXT = { met: 'Meets target', missed: 'Misses target', none: 'No data yet' };

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
    <li className={`kpi-tile metric-${result}`} data-testid={`metric-${metric}`}>
      <span className="kpi-label">{METRIC_LABELS[metric]}</span>
      <span className="kpi-value">{value === null ? '—' : formatMetric(metric, value)}</span>
      <span className="field-hint">
        Target {formatTarget(metric, target)} · <strong>{STATUS_TEXT[result]}</strong>
      </span>
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
  if (value === null) return <td className="metric-none">—</td>;
  return (
    <td className={`metric-${result}`}>
      {formatMetric(metric, value)}
      <span className="visually-hidden">, {STATUS_TEXT[result].toLowerCase()}</span>
    </td>
  );
}
