import type { APIRequestContext } from '@playwright/test';

/** The model only the `testers` Cognito group is offered, so seeing it identifies a test account (#113). */
const MOCK_MODEL_ID = 'mock';

/** Rounds of "read the first page, delete it" before giving up; 24 images a page. */
export const MAX_CLEANUP_ROUNDS = 50;

export type CleanupRequest = Pick<APIRequestContext, 'get' | 'delete'>;

/**
 * True when the signed-in account is a test account: `GET /api/models` offers the Mock model only to the
 * `testers` group, and only in dev. The cleanup deletes the whole gallery, so it runs only for such an account.
 */
export async function isTesterAccount(request: CleanupRequest): Promise<boolean> {
  const response = await request.get('/api/models');
  if (!response.ok()) throw new Error(`GET /api/models answered ${response.status()}`);
  const body = (await response.json()) as { models?: { id?: unknown }[] };
  return (body.models ?? []).some((model) => model.id === MOCK_MODEL_ID);
}

/**
 * Deletes every image in the signed-in account's gallery and returns how many it deleted. Deleting moves the
 * later images up, so it always reads the first page again until it is empty. State-changing requests need the
 * site's `Origin` (the CSRF check), which an API request doesn't send by itself.
 */
export async function deleteAllImages(request: CleanupRequest, origin: string): Promise<number> {
  let deleted = 0;
  for (let round = 0; round < MAX_CLEANUP_ROUNDS; round++) {
    const response = await request.get('/api/images');
    if (!response.ok()) throw new Error(`GET /api/images answered ${response.status()}`);
    const body = (await response.json()) as { images?: { imageId?: unknown }[] };
    const ids = (body.images ?? [])
      .map((image) => image.imageId)
      .filter((id): id is string => typeof id === 'string');
    if (ids.length === 0) return deleted;
    for (const id of ids) {
      const result = await request.delete(`/api/images/${encodeURIComponent(id)}`, {
        headers: { origin },
      });
      // A 404 means it is already gone, which is what we want.
      if (!result.ok() && result.status() !== 404) {
        throw new Error(`DELETE /api/images/${id} answered ${result.status()}`);
      }
      deleted++;
    }
  }
  throw new Error(`The gallery still has images after ${MAX_CLEANUP_ROUNDS} rounds of deleting`);
}
