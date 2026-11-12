'use client';

import { MAX_BULK_IMAGES, type BulkAction } from '@pictora/core';
import { useCallback, useRef, useState } from 'react';
import type {
  BulkBody,
  BulkResult,
  CollectionBody,
  CollectionsBody,
  TagBody,
  TagsBody,
} from './collections';

/** A failed request, with the plain-language message the API sent (GEN-10). */
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const OFFLINE = 'Something went wrong. Check your connection and try again.';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: 'no-store',
      ...init,
      ...(init?.body ? { headers: { 'Content-Type': 'application/json' } } : {}),
    });
  } catch {
    throw new ApiFailure(OFFLINE, 0);
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!response.ok) {
    throw new ApiFailure(body.error ?? OFFLINE, response.status, body.code);
  }
  return body as T;
}

export async function fetchCollections(): Promise<CollectionBody[]> {
  return (await request<CollectionsBody>('/api/collections')).collections;
}

export async function fetchTags(): Promise<TagBody[]> {
  return (await request<TagsBody>('/api/tags')).tags;
}

/** Creates a collection, or renames one when `collectionId` is given. */
export async function saveCollection(name: string, collectionId?: string): Promise<CollectionBody> {
  const body = await request<{ collection: CollectionBody }>(
    collectionId ? `/api/collections/${encodeURIComponent(collectionId)}` : '/api/collections',
    { method: collectionId ? 'PATCH' : 'POST', body: JSON.stringify({ name }) },
  );
  return body.collection;
}

export async function deleteCollection(collectionId: string): Promise<void> {
  await request(`/api/collections/${encodeURIComponent(collectionId)}`, { method: 'DELETE' });
}

/** A bulk change as the gallery sends it; any number of images, sent `MAX_BULK_IMAGES` at a time. */
export type BulkChange =
  | { action: 'move'; imageIds: string[]; collectionId: string | null }
  | { action: 'addTag' | 'removeTag'; imageIds: string[]; tag: string }
  | { action: 'delete'; imageIds: string[] };

/**
 * Sends a bulk change in requests of `MAX_BULK_IMAGES`, one after another, and returns every image's result.
 * A request that fails as a whole stops the rest and throws.
 */
export async function sendBulk(change: BulkChange): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  for (let start = 0; start < change.imageIds.length; start += MAX_BULK_IMAGES) {
    const imageIds = change.imageIds.slice(start, start + MAX_BULK_IMAGES);
    const body = await request<BulkBody>('/api/images/bulk', {
      method: 'POST',
      body: JSON.stringify({ ...change, imageIds }),
    });
    results.push(...body.results);
  }
  return results;
}

const DONE: Record<BulkAction, (count: string) => string> = {
  move: (count) => `Moved ${count}.`,
  addTag: (count) => `Tagged ${count}.`,
  removeTag: (count) => `Removed the tag from ${count}.`,
  delete: (count) => `Deleted ${count}.`,
};

function images(count: number): string {
  return `${count} ${count === 1 ? 'image' : 'images'}`;
}

/** What to tell the user after a bulk change: how many images it changed, and why any weren't. */
export function bulkSummary(
  action: BulkAction,
  results: BulkResult[],
): { message: string; failed: number } {
  const done = results.filter((result) => result.ok).length;
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) return { message: DONE[action](images(done)), failed: 0 };
  const reason = failures[0]?.ok === false ? failures[0].error : '';
  const message =
    done > 0
      ? `${DONE[action](images(done))} ${images(failures.length)} couldn't be changed: ${reason}`
      : `${images(failures.length)} couldn't be changed: ${reason}`;
  return { message, failed: failures.length };
}

/**
 * The caller's collections and tags, fetched the first time a control needs them and again after a change.
 * `load` never throws; `error` says when the last fetch failed.
 */
export function useOrganiseData() {
  const [collections, setCollections] = useState<CollectionBody[]>();
  const [tags, setTags] = useState<TagBody[]>();
  const [error, setError] = useState(false);
  const loading = useRef<Promise<void> | undefined>(undefined);

  const reload = useCallback(async () => {
    const run = (async () => {
      try {
        const [nextCollections, nextTags] = await Promise.all([fetchCollections(), fetchTags()]);
        setCollections(nextCollections);
        setTags(nextTags);
        setError(false);
      } catch {
        setError(true);
        // The next `load` tries again.
        loading.current = undefined;
      }
    })();
    loading.current = run;
    await run;
  }, []);

  const load = useCallback(async () => {
    if (loading.current) return loading.current;
    return reload();
  }, [reload]);

  return { collections, tags, error, load, reload, setCollections };
}

export type OrganiseData = ReturnType<typeof useOrganiseData>;
