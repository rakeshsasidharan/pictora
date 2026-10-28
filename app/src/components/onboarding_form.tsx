'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { GENERATE_PATH } from '../lib/site';

const LINK_CLASS = 'font-medium text-foreground underline underline-offset-4';

export interface OnboardingFormProps {
  tosVersion: string;
  /** The documents the user accepts: the terms of service and the content policy. */
  documents: { title: string; path: string }[];
  /** Where to go once accepted; tests pass a stand-in for a full page load. */
  onDone?: () => void;
}

/** The age confirmation and terms acceptance (AUTH-4). Both boxes must be ticked before it submits. */
export function OnboardingForm({ tosVersion, documents, onDone }: OnboardingFormProps) {
  const id = useId();
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ageConfirmed || !termsAccepted) {
      setError(
        !ageConfirmed && !termsAccepted
          ? 'Confirm that you are 13 or older and accept the terms to continue.'
          : !ageConfirmed
            ? 'Confirm that you are 13 or older to continue.'
            : 'Accept the terms of service and content policy to continue.',
      );
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      const response = await fetch('/api/me/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ageConfirmed, termsAccepted, tosVersion }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Something went wrong. Please try again.');
        return;
      }
      (onDone ?? (() => window.location.assign(GENERATE_PATH)))();
    } catch {
      setError('Something went wrong. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <div className="flex items-start gap-3">
        <Checkbox
          id={`${id}-age`}
          className="mt-0.5"
          checked={ageConfirmed}
          onCheckedChange={(checked) => setAgeConfirmed(checked === true)}
        />
        <Label htmlFor={`${id}-age`} className="leading-snug font-normal">
          I am 13 years old or older.
        </Label>
      </div>
      <div className="flex items-start gap-3">
        <Checkbox
          id={`${id}-terms`}
          className="mt-0.5"
          checked={termsAccepted}
          onCheckedChange={(checked) => setTermsAccepted(checked === true)}
        />
        <Label htmlFor={`${id}-terms`} className="block leading-snug font-normal">
          I accept the{' '}
          {documents.map((document, index) => (
            <span key={document.path}>
              {index > 0 && (index === documents.length - 1 ? ' and ' : ', ')}
              <a href={document.path} target="_blank" rel="noopener" className={LINK_CLASS}>
                {document.title.toLowerCase()}
              </a>
            </span>
          ))}{' '}
          (version {tosVersion}).
        </Label>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={submitting}>
        {submitting ? 'Saving…' : 'Continue'}
      </Button>
    </form>
  );
}
