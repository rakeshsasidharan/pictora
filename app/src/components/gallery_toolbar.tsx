'use client';

import { MAX_SEARCH_LENGTH } from '@pictora/core';
import { CheckSquareIcon, FolderCogIcon, SearchIcon, XIcon } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrganiseData } from '../lib/collections_client';
import type { GalleryFilterState } from '../lib/gallery_filter';

/** How long typing pauses before the search runs. */
export const SEARCH_DEBOUNCE_MS = 400;

// Select values can't be empty; a tag can't start with `_` and a collection ID is a ULID, so these never clash.
const ALL_COLLECTIONS = '__all__';
const ANY_TAG = '__any__';

export interface GalleryToolbarProps {
  filter: GalleryFilterState;
  onChange: (filter: GalleryFilterState) => void;
  data: OrganiseData;
  selecting: boolean;
  onToggleSelecting: () => void;
  onManageCollections: () => void;
  /** Debounce for typing in the search; tests shorten it. */
  debounceMs?: number;
}

/**
 * The gallery's search and filters (tech design 4.2): a search box that runs as the user types, a collection
 * and a tag to show, a button to manage collections, and one to select images for a bulk change. Collections and
 * tags load the first time a menu opens.
 */
export function GalleryToolbar({
  filter,
  onChange,
  data,
  selecting,
  onToggleSelecting,
  onManageCollections,
  debounceMs = SEARCH_DEBOUNCE_MS,
}: GalleryToolbarProps) {
  const id = useId();
  const [query, setQuery] = useState(filter.q);
  const [shownQuery, setShownQuery] = useState(filter.q);
  // A search set from outside, such as clearing the filters, replaces what was typed.
  if (filter.q !== shownQuery) {
    setShownQuery(filter.q);
    setQuery(filter.q);
  }

  const search = useEffectEvent((typed: string) => {
    if (typed.trim() !== filter.q.trim()) onChange({ ...filter, q: typed });
  });
  useEffect(() => {
    const timer = setTimeout(() => search(query), debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query !== filter.q) onChange({ ...filter, q: query });
  }

  const collections = data.collections ?? [];
  const tags = data.tags ?? [];
  // A tag reached from a link, such as an automatic tag, is offered even though it isn't one of the user's.
  const tagOptions =
    filter.tag && !tags.some((tag) => tag.tag === filter.tag)
      ? [{ tag: filter.tag, imageCount: 0 }, ...tags]
      : tags;
  const loadOnOpen = (open: boolean) => {
    if (open) void data.load();
  };

  return (
    <div
      role="search"
      aria-label="Search and filter your images"
      className="flex flex-wrap items-center gap-2"
    >
      <form className="relative min-w-48 flex-1" onSubmit={submit}>
        <label htmlFor={`${id}-q`} className="sr-only">
          Search your images
        </label>
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={`${id}-q`}
          type="search"
          value={query}
          maxLength={MAX_SEARCH_LENGTH}
          placeholder="Search prompts and tags"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          className="pr-9 pl-8"
        />
        {query && (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="absolute top-1/2 right-1.5 -translate-y-1/2"
            onClick={() => {
              setQuery('');
              onChange({ ...filter, q: '' });
            }}
          >
            <XIcon aria-hidden="true" />
            <span className="sr-only">Clear the search</span>
          </Button>
        )}
      </form>
      <Select
        value={filter.collection || ALL_COLLECTIONS}
        onOpenChange={loadOnOpen}
        onValueChange={(value) =>
          onChange({ ...filter, collection: value === ALL_COLLECTIONS ? '' : value })
        }
      >
        <SelectTrigger aria-label="Collection" className="w-44">
          <SelectValue placeholder="Collection" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_COLLECTIONS}>All images</SelectItem>
          {collections.length > 0 && <SelectSeparator />}
          {collections.map((collection) => (
            <SelectItem key={collection.collectionId} value={collection.collectionId}>
              {collection.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filter.tag || ANY_TAG}
        onOpenChange={loadOnOpen}
        onValueChange={(value) => onChange({ ...filter, tag: value === ANY_TAG ? '' : value })}
      >
        <SelectTrigger aria-label="Tag" className="w-40">
          <SelectValue placeholder="Tag" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY_TAG}>Any tag</SelectItem>
          {tagOptions.length > 0 && <SelectSeparator />}
          {tagOptions.map((tag) => (
            <SelectItem key={tag.tag} value={tag.tag}>
              {tag.tag}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => {
          void data.load();
          onManageCollections();
        }}
      >
        <FolderCogIcon aria-hidden="true" />
        <span className="sr-only">Manage collections</span>
      </Button>
      <Button
        type="button"
        variant={selecting ? 'secondary' : 'outline'}
        aria-pressed={selecting}
        onClick={onToggleSelecting}
      >
        <CheckSquareIcon aria-hidden="true" />
        {selecting ? 'Done' : 'Select'}
      </Button>
    </div>
  );
}
