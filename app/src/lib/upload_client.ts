/** The presigned POST `POST /api/uploads` answers with. */
export interface UploadTicket {
  uploadId: string;
  /** The object the file goes to; an edit sends it as a reference image without completing the upload. */
  key: string;
  url: string;
  fields: Record<string, string>;
}

/** The image `POST /api/uploads/:id/complete` made from an upload. */
export interface UploadedImage {
  imageId: string;
  version: number;
  width: number;
  height: number;
  url: string;
  downloadUrl: string;
}

/** An upload step failed; the message is in plain language for the user. */
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

/** The three steps of an upload (EDIT-2), so the component can be tested without a network. */
export interface UploadClient {
  /** Asks the app for a presigned POST for the file. */
  start: (file: File) => Promise<UploadTicket>;
  /** Sends the file straight to S3, reporting progress from 0 to 100. */
  send: (ticket: UploadTicket, file: File, onProgress: (percent: number) => void) => Promise<void>;
  /** Asks the app to check, moderate and store the uploaded file. */
  complete: (uploadId: string) => Promise<UploadedImage>;
}

const NETWORK_MESSAGE = 'Something went wrong. Check your connection and try again.';
export const S3_REJECTED_MESSAGE =
  'The upload was refused. Check the file is a JPEG, PNG or WebP image of up to 10 MB.';

async function postJson<T>(url: string, body: unknown, expected: number[]): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new UploadError(NETWORK_MESSAGE);
  }
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!expected.includes(response.status)) {
    throw new UploadError(json.error ?? "We couldn't upload your image. Please try again.");
  }
  return json;
}

/**
 * The upload client in the browser. The file goes to S3 with `XMLHttpRequest`, since `fetch` can't report
 * upload progress; S3 answers 204, or 403 when the file breaks the POST's conditions.
 */
export const browserUploadClient: UploadClient = {
  start: (file) =>
    postJson<UploadTicket>('/api/uploads', { contentType: file.type, size: file.size }, [200]),
  send: (ticket, file, onProgress) =>
    new Promise((resolve, reject) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
      // S3 ignores every field after the file, so it goes last.
      form.append('file', file);
      const request = new XMLHttpRequest();
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      });
      request.addEventListener('load', () => {
        if (request.status >= 200 && request.status < 300) resolve();
        else reject(new UploadError(S3_REJECTED_MESSAGE));
      });
      request.addEventListener('error', () => reject(new UploadError(NETWORK_MESSAGE)));
      request.open('POST', ticket.url);
      request.send(form);
    }),
  complete: async (uploadId) =>
    (
      await postJson<{ image: UploadedImage }>(
        `/api/uploads/${encodeURIComponent(uploadId)}/complete`,
        {},
        [200, 201],
      )
    ).image,
};
