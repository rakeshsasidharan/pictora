'use client';

import { MAX_COLLECTION_NAME_LENGTH, collectionNameSchema } from '@pictora/core';
import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert_dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { CollectionBody } from '../lib/collections';
import {
  ApiFailure,
  deleteCollection,
  saveCollection,
  type OrganiseData,
} from '../lib/collections_client';

export interface CollectionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: OrganiseData;
  /** Called after a collection is deleted, so a view of it can go back to all images. */
  onDeleted?: (collectionId: string) => void;
}

function message(error: unknown): string {
  return error instanceof ApiFailure ? error.message : 'Something went wrong. Please try again.';
}

/** Checks a name as the API does; the reason when it isn't valid. */
function nameError(name: string): string | undefined {
  const parsed = collectionNameSchema.safeParse(name);
  return parsed.success ? undefined : (parsed.error.issues[0]?.message ?? 'Enter a name.');
}

/**
 * Creates, renames and deletes the user's collections (tech design 4.2). Deleting a collection keeps its images
 * in the gallery, after a confirmation that says so.
 */
export function CollectionsDialog({ open, onOpenChange, data, onDeleted }: CollectionsDialogProps) {
  const id = useId();
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CollectionBody>();
  const [removing, setRemoving] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = nameError(name);
    if (invalid) {
      setCreateError(invalid);
      return;
    }
    setCreating(true);
    setCreateError(undefined);
    try {
      const collection = await saveCollection(name);
      data.setCollections((current) =>
        [...(current ?? []), collection].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        ),
      );
      setName('');
    } catch (error) {
      setCreateError(message(error));
    } finally {
      setCreating(false);
    }
  }

  async function remove(collection: CollectionBody) {
    setRemoving(true);
    try {
      await deleteCollection(collection.collectionId);
      data.setCollections((current) =>
        current?.filter((item) => item.collectionId !== collection.collectionId),
      );
      toast.success(`Deleted ${collection.name}. Its images are still in your gallery.`);
      onDeleted?.(collection.collectionId);
      setDeleting(undefined);
    } catch (error) {
      toast.error(message(error));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Collections</DialogTitle>
            <DialogDescription>
              Each image can be in one collection. Deleting a collection keeps its images.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-1" onSubmit={(event) => void create(event)} noValidate>
            <label htmlFor={`${id}-new`} className="text-sm font-medium">
              New collection
            </label>
            <div className="flex gap-2">
              <Input
                id={`${id}-new`}
                value={name}
                maxLength={MAX_COLLECTION_NAME_LENGTH}
                placeholder="For example, Logos"
                autoComplete="off"
                disabled={creating}
                aria-invalid={createError ? true : undefined}
                aria-describedby={createError ? `${id}-new-error` : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setCreateError(undefined);
                }}
              />
              <Button type="submit" disabled={creating || name.trim() === ''}>
                <PlusIcon aria-hidden="true" />
                Create
              </Button>
            </div>
            {createError && (
              <p id={`${id}-new-error`} className="text-sm text-destructive" role="alert">
                {createError}
              </p>
            )}
          </form>
          {data.collections === undefined ? (
            data.error ? (
              <p className="text-sm text-destructive" role="alert">
                We couldn&apos;t load your collections.{' '}
                <Button variant="link" className="h-auto p-0" onClick={() => void data.reload()}>
                  Try again
                </Button>
              </p>
            ) : (
              <div role="status" className="flex flex-col gap-2">
                <span className="sr-only">Loading collections…</span>
                <Skeleton aria-hidden="true" className="h-9 w-full" />
                <Skeleton aria-hidden="true" className="h-9 w-full" />
              </div>
            )
          ) : data.collections.length === 0 ? (
            <p className="text-sm text-muted-foreground">You have no collections yet.</p>
          ) : (
            <ul
              aria-label="Your collections"
              className="flex max-h-80 flex-col gap-1 overflow-y-auto"
            >
              {data.collections.map((collection) => (
                <CollectionRow
                  key={collection.collectionId}
                  collection={collection}
                  data={data}
                  onDelete={() => setDeleting(collection)}
                />
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleting !== undefined}
        onOpenChange={(next) => {
          if (!next && !removing) setDeleting(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The collection goes, but its images stay in your gallery.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              onClick={() => deleting && void remove(deleting)}
            >
              {removing ? 'Deleting…' : 'Delete collection'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** One collection in the list: its name and count, and buttons to rename it in place or delete it. */
function CollectionRow({
  collection,
  data,
  onDelete,
}: {
  collection: CollectionBody;
  data: OrganiseData;
  onDelete: () => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(collection.name);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = nameError(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const saved = await saveCollection(name, collection.collectionId);
      data.setCollections((current) =>
        current
          ?.map((item) =>
            item.collectionId === saved.collectionId ? { ...item, name: saved.name } : item,
          )
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      );
      setEditing(false);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <li>
        <form className="flex flex-col gap-1" onSubmit={(event) => void rename(event)} noValidate>
          <div className="flex items-center gap-1">
            <label htmlFor={`${id}-name`} className="sr-only">
              New name for {collection.name}
            </label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={MAX_COLLECTION_NAME_LENGTH}
              autoComplete="off"
              autoFocus
              disabled={saving}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(undefined);
              }}
              className="h-8"
            />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={saving}>
              <CheckIcon aria-hidden="true" />
              <span className="sr-only">Save name</span>
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setName(collection.name);
                setError(undefined);
              }}
            >
              <XIcon aria-hidden="true" />
              <span className="sr-only">Cancel renaming</span>
            </Button>
          </div>
          {error && (
            <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/60">
      <span className="min-w-0 flex-1 truncate text-sm">{collection.name}</span>
      <span className="text-xs text-muted-foreground">
        {collection.imageCount} {collection.imageCount === 1 ? 'image' : 'images'}
      </span>
      <Button type="button" size="icon-sm" variant="ghost" onClick={() => setEditing(true)}>
        <PencilIcon aria-hidden="true" />
        <span className="sr-only">Rename {collection.name}</span>
      </Button>
      <Button type="button" size="icon-sm" variant="ghost" onClick={onDelete}>
        <Trash2Icon aria-hidden="true" />
        <span className="sr-only">Delete {collection.name}</span>
      </Button>
    </li>
  );
}
