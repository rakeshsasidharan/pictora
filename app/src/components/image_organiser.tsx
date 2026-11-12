'use client';

import { XIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiFailure, sendBulk, useOrganiseData, type BulkChange } from '../lib/collections_client';
import { NO_FILTER, galleryUrl } from '../lib/gallery_filter';
import { TagInput } from './tag_input';

// A collection ID is a ULID, so this never clashes with one.
const NO_COLLECTION = '__none__';

/** What changed on the image, for the gallery tile. */
export interface OrganiseChange {
  tags: string[];
  collection?: { collectionId: string; name: string };
}

export interface ImageOrganiserProps {
  imageId: string;
  tags: string[];
  autoTags: string[];
  collection?: { collectionId: string; name: string };
  onChange?: (change: OrganiseChange) => void;
}

/**
 * The image's collection and tags in the detail view (tech design 4.2): a menu to move it to another collection
 * or out of its own, its tags with buttons to remove them and a field to add one, and its automatic tags. Each
 * tag links to the gallery filtered by it.
 */
export function ImageOrganiser({
  imageId,
  tags: initialTags,
  autoTags,
  collection: initialCollection,
  onChange,
}: ImageOrganiserProps) {
  const id = useId();
  const data = useOrganiseData();
  const [tags, setTags] = useState(initialTags);
  const [collection, setCollection] = useState(initialCollection);
  const [busy, setBusy] = useState(false);

  /** Sends a change of this one image; true when it went through. */
  async function change(request: BulkChange): Promise<boolean> {
    setBusy(true);
    try {
      const [result] = await sendBulk(request);
      if (result && !result.ok) {
        toast.error(result.error);
        return false;
      }
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

  async function move(value: string) {
    const target =
      value === NO_COLLECTION
        ? undefined
        : data.collections?.find((item) => item.collectionId === value);
    if (value !== NO_COLLECTION && !target) return;
    const moved = await change({
      action: 'move',
      imageIds: [imageId],
      collectionId: target?.collectionId ?? null,
    });
    if (!moved) return;
    const next = target ? { collectionId: target.collectionId, name: target.name } : undefined;
    setCollection(next);
    onChange?.({ tags, collection: next });
  }

  async function add(tag: string) {
    if (tags.includes(tag)) return;
    if (!(await change({ action: 'addTag', imageIds: [imageId], tag }))) return;
    const next = [...tags, tag].sort();
    setTags(next);
    onChange?.({ tags: next, collection });
    void data.reload();
  }

  async function remove(tag: string) {
    if (!(await change({ action: 'removeTag', imageIds: [imageId], tag }))) return;
    const next = tags.filter((item) => item !== tag);
    setTags(next);
    onChange?.({ tags: next, collection });
  }

  // The current collection is offered before the list loads, so the menu shows it.
  const options = data.collections ?? (collection ? [{ ...collection, imageCount: 0 }] : []);

  return (
    <div data-slot="image-organiser" className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-collection`} className="text-xs font-medium text-muted-foreground">
          Collection
        </label>
        <Select
          value={collection?.collectionId ?? NO_COLLECTION}
          disabled={busy}
          onOpenChange={(open) => open && void data.load()}
          onValueChange={(value) => void move(value)}
        >
          <SelectTrigger id={`${id}-collection`} size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_COLLECTION}>No collection</SelectItem>
            {options.length > 0 && <SelectSeparator />}
            {options.map((item) => (
              <SelectItem key={item.collectionId} value={item.collectionId}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div role="group" aria-labelledby={`${id}-tags`} className="flex flex-col gap-1.5">
        <p id={`${id}-tags`} className="text-xs font-medium text-muted-foreground">
          Tags
        </p>
        {(tags.length > 0 || autoTags.length > 0) && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tags of this image">
            {tags.map((tag) => (
              <li key={tag}>
                <Badge variant="secondary" className="gap-0.5 pr-0.5">
                  <Link href={galleryUrl({ ...NO_FILTER, tag })} className="hover:underline">
                    {tag}
                  </Link>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-4 rounded-full"
                    disabled={busy}
                    onClick={() => void remove(tag)}
                  >
                    <XIcon aria-hidden="true" />
                    <span className="sr-only">Remove tag {tag}</span>
                  </Button>
                </Badge>
              </li>
            ))}
            {autoTags.map((tag) => (
              <li key={`auto-${tag}`}>
                <Badge variant="outline" asChild>
                  <Link
                    href={galleryUrl({ ...NO_FILTER, tag })}
                    title="Automatic tag"
                    aria-label={`${tag}, automatic tag`}
                    className="hover:underline"
                  >
                    {tag}
                  </Link>
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <TagInput
          suggestions={data.tags}
          exclude={tags}
          disabled={busy}
          onFocus={() => void data.load()}
          onAdd={add}
        />
      </div>
    </div>
  );
}
