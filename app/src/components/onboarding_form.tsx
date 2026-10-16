'use client';

import { useState, type FormEvent } from 'react';
import { GENERATE_PATH } from '../lib/site';

export interface OnboardingFormProps {
  tosVersion: string;
  /** The documents the user accepts: the terms of service and the content policy. */
  documents: { title: string; path: string }[];
  /** Where to go once accepted; tests pass a stand-in for a full page load. */
  onDone?: () => void;
}

/** The age confirmation and terms acceptance (AUTH-4). Both boxes must be ticked before it submits. */
export function OnboardingForm({ tosVersion, documents, onDone }: OnboardingFormProps) {
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
    <form className="onboarding-form" onSubmit={submit} noValidate>
      <label>
        <input
          type="checkbox"
          checked={ageConfirmed}
          onChange={(event) => setAgeConfirmed(event.target.checked)}
        />
        I am 13 years old or older.
      </label>
      <label>
        <input
          type="checkbox"
          checked={termsAccepted}
          onChange={(event) => setTermsAccepted(event.target.checked)}
        />
        <span>
          I accept the{' '}
          {documents.map((document, index) => (
            <span key={document.path}>
              {index > 0 && (index === documents.length - 1 ? ' and ' : ', ')}
              <a href={document.path} target="_blank" rel="noopener">
                {document.title.toLowerCase()}
              </a>
            </span>
          ))}{' '}
          (version {tosVersion}).
        </span>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button button-primary" disabled={submitting}>
        {submitting ? 'Saving…' : 'Continue'}
      </button>
    </form>
  );
}
