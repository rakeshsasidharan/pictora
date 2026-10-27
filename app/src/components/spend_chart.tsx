'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { dollars, providerColour, providerLabel } from '../lib/admin_format';
import type { StatsDay } from '../lib/admin_stats';

const WIDTH = 640;
const HEIGHT = 220;
const PLOT_TOP = 12;
const PLOT_BOTTOM = 28;
const PLOT_LEFT = 48;
/** The surface gap between stacked segments and between bars. */
const GAP = 2;

/**
 * Daily provider spend as stacked bars, one theme chart colour per provider (ADM-3). Hovering or focusing a day shows its
 * total and the split by provider. The legend names every provider; the table beside it carries the numbers.
 */
export function SpendChart({ days, providers }: { days: StatsDay[]; providers: string[] }) {
  const [active, setActive] = useState<number>();
  const totals = days.map((day) =>
    providers.reduce((total, provider) => total + (day.spendCents[provider] ?? 0), 0),
  );
  const max = Math.max(1, ...totals);
  const plotHeight = HEIGHT - PLOT_TOP - PLOT_BOTTOM;
  const slot = (WIDTH - PLOT_LEFT) / Math.max(1, days.length);
  const barWidth = Math.max(2, Math.min(36, slot - GAP * 2));
  const y = (cents: number) => PLOT_TOP + plotHeight - (cents / max) * plotHeight;
  const labelEvery = Math.ceil(days.length / 7);
  const shown = active === undefined ? undefined : days[active];

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="font-medium">Daily provider spend</figcaption>
      <ul className="flex flex-wrap gap-4 text-sm" aria-label="Providers">
        {providers.map((provider) => (
          <li key={provider} className="flex items-center gap-1.5">
            <span
              className={cn('size-3 rounded-[3px]', providerColour(provider).swatch)}
              aria-hidden="true"
            />
            {providerLabel(provider)}
          </li>
        ))}
      </ul>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Daily provider spend, highest ${dollars(max)}`}
        className="block h-auto w-full"
        onMouseLeave={() => setActive(undefined)}
      >
        {[0, 0.5, 1].map((share) => (
          <g key={share}>
            <line
              x1={PLOT_LEFT}
              x2={WIDTH}
              y1={y(max * share)}
              y2={y(max * share)}
              className="stroke-border"
            />
            <text
              x={PLOT_LEFT - 6}
              y={y(max * share) + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[11px]"
            >
              {dollars(max * share)}
            </text>
          </g>
        ))}
        {days.map((day, index) => {
          const x = PLOT_LEFT + index * slot + (slot - barWidth) / 2;
          let top = y(0);
          const segments = providers.flatMap((provider) => {
            const cents = day.spendCents[provider] ?? 0;
            if (cents <= 0) return [];
            const height = Math.max(1, y(0) - y(cents));
            top -= height;
            return [{ provider, top, height }];
          });
          return (
            <g
              key={day.date}
              tabIndex={0}
              role="button"
              className="outline-none focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={`${day.date}: ${dollars(totals[index] ?? 0)}`}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(undefined)}
            >
              {/* A hit target taller and wider than the bar itself. */}
              <rect
                x={PLOT_LEFT + index * slot}
                y={PLOT_TOP}
                width={slot}
                height={plotHeight}
                fill="transparent"
              />
              {segments.map((segment, at) => (
                <rect
                  key={segment.provider}
                  x={x}
                  y={segment.top}
                  width={barWidth}
                  height={Math.max(1, segment.height - (at === 0 ? 0 : GAP))}
                  rx={at === segments.length - 1 ? 4 : 0}
                  className={providerColour(segment.provider).fill}
                />
              ))}
              {index % labelEvery === 0 && (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[11px]"
                >
                  {day.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="min-h-6 text-sm text-muted-foreground" role="status" aria-live="polite">
        {shown
          ? `${shown.date}: ${dollars(totals[active ?? 0] ?? 0)} — ${providers
              .map(
                (provider) =>
                  `${providerLabel(provider)} ${dollars(shown.spendCents[provider] ?? 0)}`,
              )
              .join(', ')}`
          : 'Hover over or focus a day to see its spend by provider.'}
      </p>
    </figure>
  );
}
