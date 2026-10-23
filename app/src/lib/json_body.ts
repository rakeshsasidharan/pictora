import { apiError, type ApiResult } from './jobs';

/** JSON request bodies are capped at 16 KB (tech design 12); the largest real one, a job, is under 5 KB. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

export type JsonBody = { ok: true; value: unknown } | { ok: false; error: ApiResult };

const tooLarge = (): JsonBody => ({
  ok: false,
  error: apiError('payload_too_large', 'The request is too large.'),
});

/**
 * Reads a JSON request body of at most `MAX_JSON_BODY_BYTES`: 413 `payload_too_large` above it, judged by
 * `Content-Length` before reading and by the bytes actually read, so a chunked body can't get past it. 400
 * `invalid_request` for a body that isn't JSON. Unknown fields are left to the route's strict zod schema.
 */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_JSON_BODY_BYTES) return tooLarge();

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return {
      ok: false,
      error: apiError('invalid_request', 'The request body must be JSON.'),
    };
  }
}
