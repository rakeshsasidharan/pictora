import { GALLERY_PATH } from './site';

/** The gallery's search and filters as the page holds them (tech design 4.2); an empty string is unset. */
export interface GalleryFilterState {
  q: string;
  tag: string;
  collection: string;
}

export const NO_FILTER: GalleryFilterState = { q: '', tag: '', collection: '' };

/** The filter from the page's search parameters (`/gallery?q=&tag=&collection=`). */
export function filterFromParams(
  params: Readonly<Record<string, string | string[] | undefined>>,
): GalleryFilterState {
  const first = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value) ?? '';
  return {
    q: first(params.q),
    tag: first(params.tag),
    collection: first(params.collection),
  };
}

export function isFiltered(filter: GalleryFilterState): boolean {
  return filter.q.trim() !== '' || filter.tag !== '' || filter.collection !== '';
}

/** True when results come ranked from a search or tag filter, paged by position rather than by image ID. */
export function isRanked(filter: GalleryFilterState): boolean {
  return filter.q.trim() !== '' || filter.tag !== '';
}

function params(filter: GalleryFilterState): URLSearchParams {
  const search = new URLSearchParams();
  if (filter.q.trim()) search.set('q', filter.q.trim());
  if (filter.tag) search.set('tag', filter.tag);
  if (filter.collection) search.set('collection', filter.collection);
  return search;
}

/** The `GET /api/images` URL of a page of the filtered gallery. */
export function galleryApiUrl(filter: GalleryFilterState, cursor?: string): string {
  const search = params(filter);
  if (cursor) search.set('cursor', cursor);
  const query = search.toString();
  return `/api/images${query ? `?${query}` : ''}`;
}

/** The gallery page showing this filter, to link to or keep in the address bar. */
export function galleryUrl(filter: GalleryFilterState): string {
  const query = params(filter).toString();
  return `${GALLERY_PATH}${query ? `?${query}` : ''}`;
}
