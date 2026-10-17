'use client';

import { DELETE_CONFIRMATION } from '@pictora/core';
import { useState } from 'react';

export interface DeleteAccountProps {
  /** Where to go once deletion has started; tests pass a stand-in for a full page load. */
  onDeleted?: () => void;
}

/**
 * The "Delete account" section (AUTH-3): what deletion removes, and a confirmation that only goes ahead once
 * the user has typed DELETE.
 */
export function DeleteAccount({ onDeleted }: DeleteAccountProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const confirmed = typed === DELETE_CONFIRMATION;

  async function confirm() {
    if (!confirmed) return;
    setError(undefined);
    setDeleting(true);
    try {
      const response = await fetch('/api/me', { method: 'DELETE' });
      if (response.status !== 202) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "We couldn't delete your account. Please try again.");
        setDeleting(false);
        return;
      }
      (onDeleted ?? (() => window.location.assign('/')))();
    } catch {
      setError('Something went wrong. Check your connection and try again.');
      setDeleting(false);
    }
  }

  function close() {
    setOpen(false);
    setTyped('');
    setError(undefined);
  }

  return (
    <section className="delete-account" aria-labelledby="delete-account-heading">
      <h2 id="delete-account-heading">Delete account</h2>
      <p>Deleting your account removes, within minutes:</p>
      <ul>
        <li>every image you created, with all its versions, thumbnails and uploads</li>
        <li>your profile, points history and settings</li>
        <li>your sign-in, so you can no longer sign in with this account</li>
      </ul>
      <p>
        Job records expire within 30 days, and safety records within 90 days. You can sign up again
        with the same email later; you will start fresh. This can&apos;t be undone.
      </p>
      {open ? (
        <div
          className="confirm-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="confirm-heading"
        >
          <h3 id="confirm-heading">Are you sure?</h3>
          <label>
            Type {DELETE_CONFIRMATION} to confirm
            <input
              type="text"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="confirm-actions">
            <button
              type="button"
              className="button button-danger"
              disabled={!confirmed || deleting}
              onClick={confirm}
            >
              {deleting ? 'Deleting…' : 'Delete my account'}
            </button>
            <button type="button" className="button" onClick={close} disabled={deleting}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="button button-danger" onClick={() => setOpen(true)}>
          Delete account
        </button>
      )}
    </section>
  );
}
