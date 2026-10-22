'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { ADMIN_RUNBOOK_URL, dollars, percent, providerLabel } from '../lib/admin_format';
import type { AdminStatsBody } from '../lib/admin_stats';
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
    <section className="admin-dashboard" aria-labelledby="dashboard-heading">
      <h1 id="dashboard-heading">Dashboard</h1>
      <form className="admin-filters" onSubmit={applyRange}>
        <label>
          From
          <input
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <button type="submit" className="button">
          Show
        </button>
      </form>

      {state.phase === 'loading' && (
        <p role="status" className="admin-note">
          Loading stats…
        </p>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="form-error">
          {state.message}
        </p>
      )}
      {state.phase === 'ready' && <StatsView stats={state.stats} />}

      <SuccessMetrics range={range} />

      <p className="admin-note">
        Model kill switches (ADM-2) and per-user point overrides (ADM-5) are changed with the AWS
        CLI; see the <a href={ADMIN_RUNBOOK_URL}>documented commands</a>.
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
      <ul className="kpi-tiles" aria-label={`Today, ${today.date}`}>
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

      <h2>
        {stats.from} to {stats.to}
      </h2>
      {empty ? (
        <p className="admin-note">No jobs or spend in this range.</p>
      ) : (
        <>
          <SpendChart days={stats.days} providers={stats.providers} />
          <div className="table-scroll">
            <table className="admin-table">
              <caption>Spend and jobs by day</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  {stats.providers.map((provider) => (
                    <th key={provider} scope="col">
                      {providerLabel(provider)}
                    </th>
                  ))}
                  <th scope="col">Enhancer</th>
                  <th scope="col">Images</th>
                  <th scope="col">Failures</th>
                  <th scope="col">Blocks</th>
                </tr>
              </thead>
              <tbody>
                {stats.days.map((day) => (
                  <tr key={day.date}>
                    <th scope="row">{day.date}</th>
                    {stats.providers.map((provider) => (
                      <td key={provider}>{dollars(day.spendCents[provider] ?? 0)}</td>
                    ))}
                    <td>{dollars(day.enhancerCostCents)}</td>
                    <td>{day.images}</td>
                    <td>{day.failures}</td>
                    <td>{day.blocks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-scroll">
            <table className="admin-table">
              <caption>By model</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Spend</th>
                  <th scope="col">Points</th>
                  <th scope="col">Images</th>
                  <th scope="col">Failures</th>
                  <th scope="col">Blocks</th>
                </tr>
              </thead>
              <tbody>
                {stats.models.map((model) => (
                  <tr key={model.modelId}>
                    <th scope="row">{model.displayName}</th>
                    <td>{providerLabel(model.provider)}</td>
                    <td>{dollars(model.providerCostCents)}</td>
                    <td>{model.points}</td>
                    <td>{model.images}</td>
                    <td>{model.failures}</td>
                    <td>{model.blocks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Top users today</h2>
      {stats.topUsers.length === 0 ? (
        <p className="admin-note">Nobody has used points today.</p>
      ) : (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Status</th>
                <th scope="col">Points today</th>
              </tr>
            </thead>
            <tbody>
              {stats.topUsers.map((user) => (
                <tr key={user.sub}>
                  <th scope="row">
                    <Link href={`/admin/users/${encodeURIComponent(user.sub)}`}>
                      {user.email ?? user.sub}
                    </Link>
                  </th>
                  <td>{user.status ?? '—'}</td>
                  <td>{user.pointsUsed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <li className="kpi-tile">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {detail && <span className="field-hint">{detail}</span>}
    </li>
  );
}
