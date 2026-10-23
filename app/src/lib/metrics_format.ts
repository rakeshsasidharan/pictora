import type { MetricId, MetricTarget } from '@pictora/core';
import { dollars, percent } from './admin_format';

/** The PRD's names for its success metrics. */
export const METRIC_LABELS: Record<MetricId, string> = {
  activation: 'Activation',
  keepRate: 'Keep rate',
  timeToFirstImage: 'Time to first image (p50)',
  generationSuccess: 'Generation success',
  weekOneRetention: 'Week-1 retention',
  costPerActiveUser: 'Cost per active user',
  falseBlocks: 'Moderation false blocks',
};

/** Milliseconds as seconds with one decimal, for example `42.5 s`. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** A metric's value in its unit: a share, seconds, or dollars (cost is kept in cents). */
export function formatMetric(metric: MetricId, value: number): string {
  if (metric === 'timeToFirstImage') return seconds(value);
  if (metric === 'costPerActiveUser') return dollars(value);
  return percent(value);
}

const COMPARISON_SIGNS: Record<MetricTarget['comparison'], string> = {
  atLeast: '≥',
  atMost: '≤',
  below: '<',
};

/** A target as the dashboard writes it, for example `≥ 70.0%` or `< 60.0 s`. */
export function formatTarget(metric: MetricId, target: MetricTarget): string {
  return `${COMPARISON_SIGNS[target.comparison]} ${formatMetric(metric, target.bound)}`;
}
