'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ADMIN_RUNBOOK_URL, dollars, percent, providerLabel } from '../lib/admin_format';
import type { AdminStatsBody } from '../lib/admin_stats';
import {
  ADMIN_CAPTION_CLASS,
  ADMIN_LINK_CLASS,
  NUMBER_CLASS,
  StatusBadge,
  TILE_GRID_CLASS,
} from './admin_parts';
import { SpendChart } from './spend_chart';
import { SuccessMetrics } from './success_metrics';

type StatsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; stats: AdminStatsBody };

/**
 * The admin dashboard (ADM-3): KPI tiles, daily spend by provider, per-model totals, today's top users, and the
 * PRD's success metrics over the same range.
 */
export function AdminDashboard() {
  const id = useId();
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [state, setState] = useState<StatsState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    void (async () => {
      try {
        const response = await fetch(`/api/admin/stats${query}`, { cache: 'no-store' });
        const body = (await response.json().catch(() => ({}))) as AdminStatsBody & {
          error?: string;
        };
        if (cancelled) return;
        if (!response.ok) {
          setState({ phase: 'error', message: body.error ?? "We couldn't load the stats." });
          return;
        }
        setState({ phase: 'ready', stats: body });
        setDraft({ from: body.from, to: body.to });
      } catch {
        if (!cancelled) setState({ phase: 'error', message: "We couldn't load the stats." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  function applyRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ phase: 'loading' });
    setRange({ from: draft.from || undefined, to: draft.to || undefined });
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="dashboard-heading">
      <h1 id="dashboard-heading" className="text-xl font-semibold">
        Dashboard
      </h1>
      <form className="flex flex-wrap items-end gap-3" onSubmit={applyRange}>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-from`}>From</Label>
          <Input
            id={`${id}-from`}
            type="date"
            className="w-auto"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-to`}>To</Label>
          <Input
            id={`${id}-to`}
            type="date"
            className="w-auto"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>

      {state.phase === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading stats…
        </p>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      {state.phase === 'ready' && <StatsView stats={state.stats} />}

      <SuccessMetrics range={range} />

      <p className="text-sm text-muted-foreground">
        Model kill switches (ADM-2) and per-user point overrides (ADM-5) are changed with the AWS
        CLI; see the{' '}
        <a href={ADMIN_RUNBOOK_URL} className={ADMIN_LINK_CLASS}>
          documented commands
        </a>
        .
      </p>
    </section>
  );
}

function StatsView({ stats }: { stats: AdminStatsBody }) {
  const { today, month } = stats;
  const empty =
    stats.totals.images === 0 && stats.totals.spendCents === 0 && stats.totals.failures === 0;
  const capShare = month.capCents > 0 ? month.spentCents / month.capCents : 0;

  return (
    <>
      <ul className={TILE_GRID_CLASS} aria-label={`Today, ${today.date}`}>
        <Tile label="Spend today" value={dollars(today.spendCents)} />
        <Tile
          label="Month to date"
          value={dollars(month.spentCents)}
          detail={`of ${dollars(month.capCents)} cap (${percent(capShare)})`}
        />
        <Tile label="Images today" value={String(today.images)} />
        <Tile label="Failure rate today" value={percent(today.failureRate)} />
        <Tile label="Blocks today" value={String(today.blocks)} />
        <Tile
          label="False blocks (reviewed)"
          value={
            stats.moderation.blocksReviewed > 0
              ? percent(stats.moderation.falseBlocks / stats.moderation.blocksReviewed)
              : '—'
          }
          detail={`${stats.moderation.falseBlocks} of ${stats.moderation.blocksReviewed} reviewed`}
        />
      </ul>

      <h2 className="text-lg font-semibold">
        {stats.from} to {stats.to}
      </h2>
      {empty ? (
        <p className="text-sm text-muted-foreground">No jobs or spend in this range.</p>
      ) : (
        <>
          <SpendChart days={stats.days} providers={stats.providers} />
          <Table className="tabular-nums">
            <TableCaption className={ADMIN_CAPTION_CLASS}>Spend and jobs by day</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Day</TableHead>
                {stats.providers.map((provider) => (
                  <TableHead key={provider} scope="col" className={NUMBER_CLASS}>
                    {providerLabel(provider)}
                  </TableHead>
                ))}
                <TableHead scope="col" className={NUMBER_CLASS}>
                  Enhancer
                </TableHead>
                <TableHead scope="col" className={NUMBER_CLASS}>
                  Images
                </TableHead>
                <TableHead scope="col" className={NUMBER_CLASS}>
                  Failures
                </TableHead>
                <TableHead scope="col" className={NUMBER_CLASS}>
                  Blocks
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.days.map((day) => (
                <TableRow key={day.date}>
                  <TableHead scope="row">{day.date}</TableHead>
                  {stats.providers.map((provider) => (
                    <TableCell key={provider} className={NUMBER_CLASS}>
                      {dollars(day.spendCents[provider] ?? 0)}
                    </TableCell>
                  ))}
                  <TableCell className={NUMBER_CLASS}>{dollars(day.enhancerCostCents)}</TableCell>
                  <TableCell className={NUMBER_CLASS}>{day.images}</TableCell>
                  <TableCell className={NUMBER_CLASS}>{day.failures}</TableCell>
                  <TableCell className={NUMBER_CLASS}>{day.blocks}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Table className="tabular-nums">
            <TableCaption className={ADMIN_CAPTION_CLASS}>By model</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Model</TableHead>
                <TableHead scope="col">Provider</TableHead>
                <TableHead scope="col" className={NUMBER_CLASS}>
                  Spend
                </TableHead>
                <TableHead scope="col" className={NUMBER_CLASS}>
                  Points
                </TableHead>
                <TableHead scope="col" className={NUMBER_CLASS}>
                  Images
                </TableHead>
                <TableHead scope="col" className={NUMBER_CLASS}>
                  Failures
                </TableHead>
                <TableHead scope="col" className={NUMBER_CLASS}>
                  Blocks
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.models.map((model) => (
                <TableRow key={model.modelId}>
                  <TableHead scope="row">{model.displayName}</TableHead>
                  <TableCell>{providerLabel(model.provider)}</TableCell>
                  <TableCell className={NUMBER_CLASS}>{dollars(model.providerCostCents)}</TableCell>
                  <TableCell className={NUMBER_CLASS}>{model.points}</TableCell>
                  <TableCell className={NUMBER_CLASS}>{model.images}</TableCell>
                  <TableCell className={NUMBER_CLASS}>{model.failures}</TableCell>
                  <TableCell className={NUMBER_CLASS}>{model.blocks}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}

      <h2 className="text-lg font-semibold">Top users today</h2>
      {stats.topUsers.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody has used points today.</p>
      ) : (
        <Table className="tabular-nums">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">User</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col" className={NUMBER_CLASS}>
                Points today
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.topUsers.map((user) => (
              <TableRow key={user.sub}>
                <TableHead scope="row">
                  <Link
                    href={`/admin/users/${encodeURIComponent(user.sub)}`}
                    className={ADMIN_LINK_CLASS}
                  >
                    {user.email ?? user.sub}
                  </Link>
                </TableHead>
                <TableCell>
                  <StatusBadge status={user.status} />
                </TableCell>
                <TableCell className={NUMBER_CLASS}>{user.pointsUsed}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <li>
      <Card className="h-full gap-1 py-4">
        <CardHeader className="gap-1 px-4">
          <CardDescription>{label}</CardDescription>
          <CardTitle className="text-2xl font-bold tabular-nums">{value}</CardTitle>
        </CardHeader>
        {detail && (
          <CardContent className="px-4 text-sm text-muted-foreground">{detail}</CardContent>
        )}
      </Card>
    </li>
  );
}
