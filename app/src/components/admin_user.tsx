'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { AdminUserBody } from '../lib/admin_users';

type UserState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; user: AdminUserBody };

/** A user's profile for admins, with Suspend or Unsuspend (ADM-4). */
export function AdminUser({ sub }: { sub: string }) {
  const [state, setState] = useState<UserState>({ phase: 'loading' });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/admin/users/${encodeURIComponent(sub)}`, {
          cache: 'no-store',
        });
        const body = (await response.json().catch(() => ({}))) as AdminUserBody & {
          error?: string;
        };
        if (cancelled) return;
        setState(
          response.ok
            ? { phase: 'ready', user: body }
            : { phase: 'error', message: body.error ?? "We couldn't load this user." },
        );
      } catch {
        if (!cancelled) setState({ phase: 'error', message: "We couldn't load this user." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sub]);

  async function change(action: 'suspend' | 'unsuspend') {
    setSaving(true);
    setActionError(undefined);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(sub)}/${action}`, {
        method: 'POST',
      });
      const body = (await response.json().catch(() => ({}))) as {
        status?: AdminUserBody['status'];
        error?: string;
      };
      if (!response.ok || !body.status) {
        setActionError(body.error ?? "We couldn't change this account.");
        return;
      }
      const status = body.status;
      setState((current) =>
        current.phase === 'ready' ? { phase: 'ready', user: { ...current.user, status } } : current,
      );
    } catch {
      setActionError('Something went wrong. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  if (state.phase === 'loading') {
    return (
      <p role="status" className="admin-note">
        Loading user…
      </p>
    );
  }
  if (state.phase === 'error') {
    return (
      <p role="alert" className="form-error">
        {state.message}
      </p>
    );
  }
  const { user } = state;
  return (
    <section className="admin-user" aria-labelledby="user-heading">
      <h1 id="user-heading">{user.email ?? user.sub}</h1>
      <dl className="account-details">
        <dt>User ID</dt>
        <dd>{user.sub}</dd>
        <dt>Status</dt>
        <dd>{user.status}</dd>
        <dt>Member since</dt>
        <dd>{user.createdAt.slice(0, 10)}</dd>
        <dt>Points today</dt>
        <dd>
          {user.pointsUsedToday} of {user.dailyLimit}
          {user.dailyPoints !== undefined ? ' (override)' : ''}
        </dd>
        <dt>Running jobs</dt>
        <dd>{user.activeJobs}</dd>
        {user.abuseFlag && (
          <>
            <dt>Abuse flag</dt>
            <dd>{user.abuseFlag}</dd>
          </>
        )}
        {user.cooldownUntil && (
          <>
            <dt>Cooldown until</dt>
            <dd>{user.cooldownUntil}</dd>
          </>
        )}
      </dl>
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {user.status === 'active' && (
        <button
          type="button"
          className="button button-danger"
          disabled={saving}
          onClick={() => void change('suspend')}
        >
          Suspend
        </button>
      )}
      {user.status === 'suspended' && (
        <button
          type="button"
          className="button"
          disabled={saving}
          onClick={() => void change('unsuspend')}
        >
          Unsuspend
        </button>
      )}
      {user.status === 'deleting' && <p className="admin-note">This account is being deleted.</p>}
    </section>
  );
}

/** Finds a user by their `sub` (from the Cognito console, a moderation entry or the top users). */
export function UserLookup() {
  const router = useRouter();
  const [sub, setSub] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = sub.trim();
    if (value) router.push(`/admin/users/${encodeURIComponent(value)}`);
  }

  return (
    <section aria-labelledby="lookup-heading">
      <h1 id="lookup-heading">Users</h1>
      <form className="admin-filters" onSubmit={submit}>
        <label>
          User ID (sub)
          <input type="text" value={sub} onChange={(event) => setSub(event.target.value)} />
        </label>
        <button type="submit" className="button">
          Find
        </button>
      </form>
      <p className="admin-note">
        Find the user ID in the Cognito console, in the moderation review, or in the
        dashboard&apos;s top users.
      </p>
    </section>
  );
}
