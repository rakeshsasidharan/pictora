'use client';

import type { ReviewVerdict } from '@pictora/core';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ModerationEntry, ModerationListBody } from '../lib/admin_moderation';
import { ADMIN_LINK_CLASS } from './admin_parts';

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
  const dayId = useId();
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
    <section className="flex flex-col gap-6" aria-labelledby="moderation-heading">
      <h1 id="moderation-heading" className="text-xl font-semibold">
        Moderation review
      </h1>
      <div className="flex flex-col gap-2">
        <Label htmlFor={dayId}>Day</Label>
        <Input
          id={dayId}
          type="date"
          className="w-auto self-start"
          value={date}
          onChange={(event) => {
            if (!event.target.value) return;
            setState({ phase: 'loading' });
            setDate(event.target.value);
          }}
        />
      </div>
      {actionError && (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      )}
      {state.phase === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading entries…
        </p>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      {state.phase === 'ready' && state.entries.length === 0 && (
        <p className="text-sm text-muted-foreground">No blocks or reports on {date}.</p>
      )}
      {state.phase === 'ready' && state.entries.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Entries">
          {state.entries.map((entry) => (
            <li key={entry.id}>
              <Card className="flex-row flex-wrap gap-x-4 gap-y-3 p-4">
                {entry.thumbUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them
                  <img
                    src={entry.thumbUrl}
                    alt="Reported image"
                    width={96}
                    height={96}
                    className="size-24 rounded-md object-cover"
                  />
                )}
                <div className="flex min-w-[min(100%,15rem)] flex-1 flex-col gap-1 text-sm break-words">
                  <p className="font-medium">
                    {entry.type === 'block'
                      ? `Block · ${entry.stage} · ${entry.category}`
                      : `Report · ${entry.reason}`}
                  </p>
                  <p>{entry.promptExcerpt || <em>No prompt (uploaded image)</em>}</p>
                  <p className="text-muted-foreground">
                    {new Date(entry.createdAt).toISOString().slice(11, 16)} UTC ·{' '}
                    <Link
                      href={`/admin/users/${encodeURIComponent(entry.userId)}`}
                      className={ADMIN_LINK_CLASS}
                    >
                      {entry.userId}
                    </Link>
                    {entry.modelId ? ` · ${entry.modelId}` : ''}
                  </p>
                  <p aria-live="polite">
                    <Badge variant={entry.review ? 'outline' : 'secondary'}>
                      {entry.review ? `Reviewed: ${VERDICT_LABELS[entry.review]}` : 'Not reviewed'}
                    </Badge>
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {(['ok', 'confirmed'] as const).map((verdict) => (
                    <Button
                      key={verdict}
                      type="button"
                      size="sm"
                      variant={entry.review === verdict ? 'default' : 'outline'}
                      aria-pressed={entry.review === verdict}
                      aria-label={`${VERDICT_LABELS[verdict]}: ${entry.id}`}
                      disabled={saving === entry.id}
                      onClick={() => void review(entry, verdict)}
                    >
                      {VERDICT_LABELS[verdict]}
                    </Button>
                  ))}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
