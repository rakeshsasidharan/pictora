import { MAX_UPLOAD_BYTES, UPLOAD_CONTENT_TYPES } from '@pictora/core';

/** The file picker's `accept` list: the types an upload may be (EDIT-2). */
export const UPLOAD_ACCEPT = UPLOAD_CONTENT_TYPES.join(',');

export const WRONG_TYPE_MESSAGE = 'Only JPEG, PNG or WebP images can be uploaded.';
export const TOO_LARGE_MESSAGE = 'That file is too large. Images can be up to 10 MB.';
export const EMPTY_FILE_MESSAGE = 'That file is empty. Pick another image.';

/**
 * Why a file can't be uploaded, checked in the browser before anything is sent; undefined when it can. The
 * presigned POST and the complete step check the same limits again.
 */
export function uploadFileError(file: Pick<File, 'type' | 'size'>): string | undefined {
  if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(file.type)) return WRONG_TYPE_MESSAGE;
  if (file.size > MAX_UPLOAD_BYTES) return TOO_LARGE_MESSAGE;
  if (file.size === 0) return EMPTY_FILE_MESSAGE;
  return undefined;
}
