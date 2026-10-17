'use client';

import { REPORT_REASONS, type ReportReason } from '@pictora/core';
import { useState, type FormEvent } from 'react';

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  sexual: 'Sexual content',
  violence: 'Graphic violence',
  hate: 'Hate or harassment',
  'self-harm': 'Self-harm',
  illegal: 'Illegal activity',
  'real-person': 'Harmful image of a real person',
  other: 'Something else',
};

/**
 * The "Report" action for an image version (PRD, Trust and safety): pick a reason and send it to
 * `POST /api/reports` for review. Shown in the image view.
 */
export function ReportImage({ imageId, version }: { imageId: string; version: number }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason) {
      setError('Pick a reason for the report.');
      return;
    }
    setError(undefined);
    setSending(true);
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId, version, reason }),
      });
      if (response.status !== 201) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "We couldn't send your report. Please try again.");
        return;
      }
      setSent(true);
    } catch {
      setError('Something went wrong. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  function close() {
    setOpen(false);
    setReason(undefined);
    setError(undefined);
  }

  if (sent) {
    return (
      <p className="report-sent" role="status">
        Thanks for reporting this image. We&apos;ll review it.
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" className="button" onClick={() => setOpen(true)}>
        Report
      </button>
    );
  }
  return (
    <form className="report-panel" onSubmit={submit} noValidate>
      <fieldset>
        <legend>What&apos;s wrong with this image?</legend>
        {REPORT_REASONS.map((value) => (
          <label key={value}>
            <input
              type="radio"
              name={`report-${imageId}-${version}`}
              value={value}
              checked={reason === value}
              onChange={() => setReason(value)}
            />
            {REPORT_REASON_LABELS[value]}
          </label>
        ))}
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <button type="submit" className="button button-primary" disabled={sending}>
          {sending ? 'Sending…' : 'Send report'}
        </button>
        <button type="button" className="button" onClick={close} disabled={sending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
