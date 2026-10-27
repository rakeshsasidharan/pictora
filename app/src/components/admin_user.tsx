'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert_dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AdminUserBody } from '../lib/admin_users';
import { StatusBadge } from './admin_parts';

type UserState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; user: AdminUserBody };

type Action = 'suspend' | 'unsuspend';

/** What each action's confirmation says. A suspended user's job, enhance and upload requests answer 403. */
const ACTIONS: Record<Action, { label: string; confirm: string; description: string }> = {
  suspend: {
    label: 'Suspend',
    confirm: 'Suspend account',
    description:
      'They will no longer be able to generate, edit, enhance or upload images until the account is unsuspended.',
  },
  unsuspend: {
    label: 'Unsuspend',
    confirm: 'Unsuspend account',
    description: 'They will be able to use Pictora again straight away.',
  },
};

/**
 * A user's profile for admins, with Suspend or Unsuspend (ADM-4). Either asks first in an alert dialog, which
 * stays open while the change runs and shows its error.
 */
export function AdminUser({ sub }: { sub: string }) {
  const [state, setState] = useState<UserState>({ phase: 'loading' });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [confirming, setConfirming] = useState(false);

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

  async function change(action: Action) {
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
      setConfirming(false);
    } catch {
      setActionError('Something went wrong. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  if (state.phase === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading user…
      </p>
    );
  }
  if (state.phase === 'error') {
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.message}
      </p>
    );
  }
  const { user } = state;
  const action: Action | undefined =
    user.status === 'active' ? 'suspend' : user.status === 'suspended' ? 'unsuspend' : undefined;
  const fields: { label: string; value: ReactNode }[] = [
    { label: 'User ID', value: user.sub },
    { label: 'Status', value: <StatusBadge status={user.status} /> },
    { label: 'Member since', value: user.createdAt.slice(0, 10) },
    {
      label: 'Points today',
      value: `${user.pointsUsedToday} of ${user.dailyLimit}${user.dailyPoints !== undefined ? ' (override)' : ''}`,
    },
    { label: 'Running jobs', value: user.activeJobs },
    ...(user.abuseFlag ? [{ label: 'Abuse flag', value: user.abuseFlag }] : []),
    ...(user.cooldownUntil ? [{ label: 'Cooldown until', value: user.cooldownUntil }] : []),
  ];

  return (
    <section className="flex max-w-2xl flex-col gap-6" aria-labelledby="user-heading">
      <h1 id="user-heading" className="text-xl font-semibold break-words">
        {user.email ?? user.sub}
      </h1>
      <Card>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            {fields.map((field) => (
              <div key={field.label} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="break-all">{field.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
        <CardFooter>
          {action ? (
            <AlertDialog
              open={confirming}
              onOpenChange={(open) => {
                if (saving) return;
                setConfirming(open);
                if (!open) setActionError(undefined);
              }}
            >
              <AlertDialogTrigger asChild>
                <Button type="button" variant={action === 'suspend' ? 'destructive' : 'outline'}>
                  {ACTIONS[action].label}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="break-words">
                    {ACTIONS[action].label} {user.email ?? user.sub}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>{ACTIONS[action].description}</AlertDialogDescription>
                </AlertDialogHeader>
                {actionError && (
                  <p className="text-sm text-destructive" role="alert">
                    {actionError}
                  </p>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
                  <Button
                    type="button"
                    variant={action === 'suspend' ? 'destructive' : 'default'}
                    disabled={saving}
                    onClick={() => void change(action)}
                  >
                    {saving ? 'Saving…' : ACTIONS[action].confirm}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <p className="text-sm text-muted-foreground">This account is being deleted.</p>
          )}
        </CardFooter>
      </Card>
    </section>
  );
}

/** Finds a user by their `sub` (from the Cognito console, a moderation entry or the top users). */
export function UserLookup() {
  const router = useRouter();
  const inputId = useId();
  const [sub, setSub] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = sub.trim();
    if (value) router.push(`/admin/users/${encodeURIComponent(value)}`);
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="lookup-heading">
      <h1 id="lookup-heading" className="text-xl font-semibold">
        Users
      </h1>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <div className="flex w-full max-w-sm flex-col gap-2">
          <Label htmlFor={inputId}>User ID (sub)</Label>
          <Input
            id={inputId}
            type="text"
            value={sub}
            onChange={(event) => setSub(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline">
          Find
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Find the user ID in the Cognito console, in the moderation review, or in the
        dashboard&apos;s top users.
      </p>
    </section>
  );
}
