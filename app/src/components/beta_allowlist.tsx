'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { BetaAllowlistBody } from '../lib/beta';
import { ADMIN_CAPTION_CLASS } from './admin_parts';

type ListState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | ({ phase: 'ready' } & BetaAllowlistBody);

type Entry = BetaAllowlistBody['entries'][number];

const LOAD_ERROR = "We couldn't load the allowlist.";
const NETWORK_ERROR = 'Something went wrong. Check your connection and try again.';

/** The allowlist URL for one email. */
function entryUrl(email: string): string {
  return `/api/admin/beta/allowlist/${encodeURIComponent(email)}`;
}

function byEmail(a: Entry, b: Entry): number {
  return a.email.localeCompare(b.email);
}

/**
 * The private beta allowlist for admins (M4): whether beta mode is on, a form to add an email, and the list with
 * a Remove button on each. While beta mode is on, only these emails can sign up, with email or Google.
 */
export function BetaAllowlist() {
  const inputId = useId();
  const [state, setState] = useState<ListState>({ phase: 'loading' });
  const [email, setEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string>();
  const [removing, setRemoving] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/admin/beta/allowlist', { cache: 'no-store' });
        const body = (await response.json().catch(() => ({}))) as Partial<BetaAllowlistBody> & {
          error?: string;
        };
        if (cancelled) return;
        setState(
          response.ok && body.entries
            ? {
                phase: 'ready',
                betaMode: body.betaMode === true,
                entries: [...body.entries].sort(byEmail),
              }
            : { phase: 'error', message: body.error ?? LOAD_ERROR },
        );
      } catch {
        if (!cancelled) setState({ phase: 'error', message: LOAD_ERROR });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = email.trim();
    if (!value) {
      setAddError('Enter an email address.');
      return;
    }
    setAdding(true);
    setAddError(undefined);
    try {
      const response = await fetch('/api/admin/beta/allowlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      const body = (await response.json().catch(() => ({}))) as Partial<Entry> & {
        error?: string;
      };
      if (!response.ok || !body.email) {
        setAddError(body.error ?? "We couldn't add this email.");
        return;
      }
      const entry: Entry = {
        email: body.email,
        addedAt: body.addedAt ?? '',
        addedBy: body.addedBy ?? '',
      };
      setState((current) =>
        current.phase === 'ready'
          ? {
              ...current,
              entries: [
                ...current.entries.filter((existing) => existing.email !== entry.email),
                entry,
              ].sort(byEmail),
            }
          : current,
      );
      setEmail('');
      toast(`Added ${entry.email}`);
    } catch {
      setAddError(NETWORK_ERROR);
    } finally {
      setAdding(false);
    }
  }

  async function remove(target: string) {
    setRemoving(target);
    try {
      const response = await fetch(entryUrl(target), { method: 'DELETE' });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      // Already gone counts as removed.
      if (!response.ok && response.status !== 404) {
        toast.error(body.error ?? `We couldn't remove ${target}.`);
        return;
      }
      setState((current) =>
        current.phase === 'ready'
          ? { ...current, entries: current.entries.filter((entry) => entry.email !== target) }
          : current,
      );
      toast(`Removed ${target}`);
    } catch {
      toast.error(NETWORK_ERROR);
    } finally {
      setRemoving(undefined);
    }
  }

  return (
    <section className="flex min-w-0 flex-col gap-6" aria-labelledby="beta-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="beta-heading" className="text-xl font-semibold">
          Beta allowlist
        </h1>
        {state.phase === 'ready' && (
          <Badge variant={state.betaMode ? 'default' : 'outline'}>
            Beta mode {state.betaMode ? 'on' : 'off'}
          </Badge>
        )}
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        While beta mode is on, only these emails can sign up, with email or Google. Existing
        accounts and admins are not affected. Beta mode is set per environment in the CDK config.
      </p>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => void add(event)}
        noValidate
      >
        <div className="flex w-full max-w-sm flex-col gap-2">
          <Label htmlFor={inputId}>Email</Label>
          <Input
            id={inputId}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? `${inputId}-error` : undefined}
            placeholder="name@example.com"
          />
        </div>
        <Button type="submit" disabled={adding}>
          {adding ? 'Adding…' : 'Add'}
        </Button>
        {addError && (
          <p id={`${inputId}-error`} role="alert" className="w-full text-sm text-destructive">
            {addError}
          </p>
        )}
      </form>

      {state.phase === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading allowlist…
        </p>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      {state.phase === 'ready' &&
        (state.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No emails on the allowlist yet.</p>
        ) : (
          <Table>
            <TableCaption className={ADMIN_CAPTION_CLASS}>
              {state.entries.length} {state.entries.length === 1 ? 'email' : 'emails'}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Added</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.entries.map((entry) => (
                <TableRow key={entry.email}>
                  <TableCell className="break-all whitespace-normal">{entry.email}</TableCell>
                  <TableCell>{entry.addedAt ? entry.addedAt.slice(0, 10) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={removing === entry.email}
                      aria-label={`Remove ${entry.email}`}
                      onClick={() => void remove(entry.email)}
                    >
                      {removing === entry.email ? 'Removing…' : 'Remove'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </section>
  );
}
