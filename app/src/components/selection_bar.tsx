'use client';

import { collectionNameSchema, MAX_COLLECTION_NAME_LENGTH } from '@pictora/core';
import { FolderInputIcon, TagIcon, TagsIcon, Trash2Icon, XIcon } from 'lucide-react';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown_menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { BulkResult } from '../lib/collections';
import {
  ApiFailure,
  bulkSummary,
  saveCollection,
  sendBulk,
  type BulkChange,
  type OrganiseData,
} from '../lib/collections_client';
import { TagInput } from './tag_input';

export interface SelectionBarProps {
  /** The selected images, in grid order. */
  selected: string[];
  /** The user's tags on the selected images, offered for removal. */
  selectedTags: string[];
  /** How many images are shown, for "Select all". */
  shown: number;
  data: OrganiseData;
  onSelectAll: () => void;
  onClear: () => void;
  /** Called after a change with each image's result, so the grid can show it. */
  onChanged: (change: BulkChange, results: BulkResult[]) => void;
}

/**
 * The bar shown while images are selected (tech design 4.2): move them to a collection (a new one included) or
 * out of theirs, add or remove a tag, or delete them after a confirmation. Each change reports how many images
 * it changed, and why any weren't.
 */
export function SelectionBar({
  selected,
  selectedTags,
  shown,
  data,
  onSelectAll,
  onClear,
  onChanged,
}: SelectionBarProps) {
  const [busy, setBusy] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [newCollection, setNewCollection] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const count = selected.length;
  const none = count === 0;

  async function apply(change: BulkChange): Promise<boolean> {
    setBusy(true);
    try {
      const results = await sendBulk(change);
      const summary = bulkSummary(change.action, results);
      if (summary.failed > 0) toast.error(summary.message);
      else toast.success(summary.message);
      onChanged(change, results);
      // Collection and tag counts changed.
      void data.reload();
      return true;
    } catch (error) {
      toast.error(
        error instanceof ApiFailure ? error.message : 'Something went wrong. Please try again.',
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Selected images"
      className="sticky bottom-4 z-10 flex flex-wrap items-center gap-2 rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur"
    >
      <p className="px-2 text-sm font-medium" aria-live="polite">
        {count} selected
      </p>
      {count < shown && (
        <Button type="button" size="sm" variant="ghost" onClick={onSelectAll} disabled={busy}>
          Select all {shown}
        </Button>
      )}
      <div className="flex flex-1 flex-wrap justify-end gap-2">
        <DropdownMenu onOpenChange={(open) => open && void data.load()}>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="outline" disabled={none || busy}>
              <FolderInputIcon aria-hidden="true" />
              Move to
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel>Collection</DropdownMenuLabel>
            {data.collections === undefined && !data.error && (
              <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
            )}
            {data.error && (
              <DropdownMenuItem disabled>We couldn&apos;t load your collections.</DropdownMenuItem>
            )}
            {data.collections?.map((collection) => (
              <DropdownMenuItem
                key={collection.collectionId}
                onSelect={() =>
                  void apply({
                    action: 'move',
                    imageIds: selected,
                    collectionId: collection.collectionId,
                  })
                }
              >
                {collection.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setNewCollection(true)}>
              New collection…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void apply({ action: 'move', imageIds: selected, collectionId: null })
              }
            >
              No collection
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover
          open={tagging}
          onOpenChange={(open) => {
            setTagging(open);
            if (open) void data.load();
          }}
        >
          <PopoverTrigger asChild>
            <Button type="button" size="sm" variant="outline" disabled={none || busy}>
              <TagIcon aria-hidden="true" />
              Add tag
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <TagInput
              label={`Tag ${count} ${count === 1 ? 'image' : 'images'}`}
              suggestions={data.tags}
              disabled={busy}
              onAdd={async (tag) => {
                if (await apply({ action: 'addTag', imageIds: selected, tag })) setTagging(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={none || busy || selectedTags.length === 0}
            >
              <TagsIcon aria-hidden="true" />
              Remove tag
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            {selectedTags.map((tag) => (
              <DropdownMenuItem
                key={tag}
                onSelect={() => void apply({ action: 'removeTag', imageIds: selected, tag })}
              >
                {tag}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={none || busy}
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2Icon aria-hidden="true" />
          Delete
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClear} disabled={busy}>
          <XIcon aria-hidden="true" />
          Clear
        </Button>
      </div>

      <NewCollectionDialog
        open={newCollection}
        onOpenChange={setNewCollection}
        onCreated={async (collectionId) => {
          await apply({ action: 'move', imageIds: selected, collectionId });
        }}
      />
      <AlertDialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!busy) setConfirmingDelete(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {count} {count === 1 ? 'image' : 'images'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every version of {count === 1 ? 'it' : 'them'} is deleted. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                await apply({ action: 'delete', imageIds: selected });
                setConfirmingDelete(false);
              }}
            >
              {busy ? 'Deleting…' : `Delete ${count === 1 ? 'image' : 'images'}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Names a new collection for the selected images to move to. */
function NewCollectionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (collectionId: string) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = collectionNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a name.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const collection = await saveCollection(parsed.data);
      onOpenChange(false);
      setName('');
      await onCreated(collection.collectionId);
    } catch (failure) {
      setError(
        failure instanceof ApiFailure ? failure.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-sm">
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription>The selected images move into it.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">
              Name
            </label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={MAX_COLLECTION_NAME_LENGTH}
              autoComplete="off"
              disabled={saving}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(undefined);
              }}
            />
            {error && (
              <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving || name.trim() === ''}>
              {saving ? 'Creating…' : 'Create and move'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
