'use client';

import type { ReviewVerdict } from '@pictora/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ModerationEntry, ModerationListBody } from '../lib/admin_moderation';

type ListState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; entries: ModerationEntry[] };

export const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  ok: 'OK (false block)',
  confirmed: 'Confirmed',
};

/**
 * The moderation review queue (ADM-4): a day's blocks and reports, each marked `ok` (a false block) or
 * `confirmed`. Reports show the reported image's thumbnail.
 */
export function ModerationReview({ initialDate }: { initialDate: string }) {
  const [date, setDate] = useState(initialDate);
  const [state, setState] = useState<ListState>({ phase: 'loading' });
  const [actionError, setActionError] = useState<string>();
  const [saving, setSaving] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/admin/moderation?date=${encodeURIComponent(date)}`, {
          cache: 'no-store',
        });
        const body = (await response.json().catch(() => ({}))) as ModerationListBody & {
          error?: string;
        };
        if (cancelled) return;
        setState(
          response.ok
            ? { phase: 'ready', entries: body.entries }
            : { phase: 'error', message: body.error ?? "We couldn't load the entries." },
        );
      } catch {
        if (!cancelled) setState({ phase: 'error', message: "We couldn't load the entries." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [date]);

  async function review(entry: ModerationEntry, verdict: ReviewVerdict) {
    setActionError(undefined);
    setSaving(entry.id);
    try {
      const response = await fetch(
        `/api/admin/moderation/${entry.date}/${encodeURIComponent(entry.id)}/review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verdict }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setActionError(body.error ?? "We couldn't save the review.");
        return;
      }
      setState((current) =>
        current.phase === 'ready'
          ? {
              phase: 'ready',
              entries: current.entries.map((item) =>
                item.id === entry.id ? { ...item, review: verdict } : item,
              ),
            }
          : current,
      );
    } catch {
      setActionError('Something went wrong. Check your connection and try again.');
    } finally {
      setSaving(undefined);
    }
  }

  return (
    <section className="moderation-review" aria-labelledby="moderation-heading">
      <h1 id="moderation-heading">Moderation review</h1>
      <label className="admin-filters">
        Day
        <input
          type="date"
          value={date}
          onChange={(event) => {
            if (!event.target.value) return;
            setState({ phase: 'loading' });
            setDate(event.target.value);
          }}
        />
      </label>
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {state.phase === 'loading' && (
        <p role="status" className="admin-note">
          Loading entries…
        </p>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="form-error">
          {state.message}
        </p>
      )}
      {state.phase === 'ready' && state.entries.length === 0 && (
        <p className="admin-note">No blocks or reports on {date}.</p>
      )}
      {state.phase === 'ready' && state.entries.length > 0 && (
        <ul className="moderation-list" aria-label="Entries">
          {state.entries.map((entry) => (
            <li key={entry.id} className="moderation-entry">
              {entry.thumbUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them
                <img src={entry.thumbUrl} alt="Reported image" width={96} height={96} />
              )}
              <div className="moderation-details">
                <p className="moderation-title">
                  {entry.type === 'block'
                    ? `Block · ${entry.stage} · ${entry.category}`
                    : `Report · ${entry.reason}`}
                </p>
                <p>{entry.promptExcerpt || <em>No prompt (uploaded image)</em>}</p>
                <p className="field-hint">
                  {new Date(entry.createdAt).toISOString().slice(11, 16)} UTC ·{' '}
                  <Link href={`/admin/users/${encodeURIComponent(entry.userId)}`}>
                    {entry.userId}
                  </Link>
                  {entry.modelId ? ` · ${entry.modelId}` : ''}
                </p>
                <p className="field-hint" aria-live="polite">
                  {entry.review ? `Reviewed: ${VERDICT_LABELS[entry.review]}` : 'Not reviewed'}
                </p>
              </div>
              <div className="result-actions">
                {(['ok', 'confirmed'] as const).map((verdict) => (
                  <button
                    key={verdict}
                    type="button"
                    className="button"
                    aria-pressed={entry.review === verdict}
                    aria-label={`${VERDICT_LABELS[verdict]}: ${entry.id}`}
                    disabled={saving === entry.id}
                    onClick={() => void review(entry, verdict)}
                  >
                    {VERDICT_LABELS[verdict]}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
