'use client';

import { REPORT_REASONS, type ReportReason } from '@pictora/core';
import { FlagIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio_group';

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  sexual: 'Sexual content',
  violence: 'Graphic violence',
  hate: 'Hate or harassment',
  'self-harm': 'Self-harm',
  illegal: 'Illegal activity',
  'real-person': 'Harmful image of a real person',
  other: 'Something else',
};

/** Shown once a report is sent. */
export const REPORT_SENT_MESSAGE = "Thanks for reporting this image. We'll review it.";

/**
 * The "Report" action for an image version (PRD, Trust and safety): a dialog to pick a reason, sent to
 * `POST /api/reports` for review, then a thank-you toast. Shown in the image views.
 */
export function ReportImage({ imageId, version }: { imageId: string; version: number }) {
  const id = useId();
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
      setOpen(false);
      toast.success(REPORT_SENT_MESSAGE);
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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else if (!sending) close();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={sent}>
          <FlagIcon aria-hidden="true" />
          {sent ? 'Reported' : 'Report'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Report this image</DialogTitle>
            <DialogDescription>
              What&apos;s wrong with this image? We review every report.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup
            aria-label="Reason"
            value={reason ?? ''}
            onValueChange={(value) => setReason(value as ReportReason)}
          >
            {REPORT_REASONS.map((value) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-${value}`} value={value} />
                <Label htmlFor={`${id}-${value}`} className="font-normal">
                  {REPORT_REASON_LABELS[value]}
                </Label>
              </div>
            ))}
          </RadioGroup>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={sending}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending}>
              {sending ? 'Sending…' : 'Send report'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
