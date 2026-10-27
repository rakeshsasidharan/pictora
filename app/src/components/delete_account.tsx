'use client';

import { DELETE_CONFIRMATION } from '@pictora/core';
import { useId, useState } from 'react';
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
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface DeleteAccountProps {
  /** Where to go once deletion has started; tests pass a stand-in for a full page load. */
  onDeleted?: () => void;
}

/**
 * The "Delete account" card (AUTH-3): what deletion removes, and a confirmation in an alert dialog that only
 * goes ahead once the user has typed DELETE. The dialog stays open while the request runs, so its error shows.
 */
export function DeleteAccount({ onDeleted }: DeleteAccountProps) {
  const inputId = useId();
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

  function changeOpen(next: boolean) {
    if (deleting) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      setError(undefined);
    }
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>
          <h2>Delete account</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p>Deleting your account removes, within minutes:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>every image you created, with all its versions, thumbnails and uploads</li>
          <li>your profile, points history and settings</li>
          <li>your sign-in, so you can no longer sign in with this account</li>
        </ul>
        <p className="text-muted-foreground">
          Job records expire within 30 days, and safety records within 90 days. You can sign up
          again with the same email later; you will start fresh. This can&apos;t be undone.
        </p>
      </CardContent>
      <CardFooter>
        <AlertDialog open={open} onOpenChange={changeOpen}>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="destructive">
              Delete account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                Your images, profile and sign-in will be deleted. This can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={inputId}>Type {DELETE_CONFIRMATION} to confirm</Label>
              <Input
                id={inputId}
                type="text"
                value={typed}
                autoComplete="off"
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                disabled={!confirmed || deleting}
                onClick={() => void confirm()}
              >
                {deleting ? 'Deleting…' : 'Delete my account'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}
