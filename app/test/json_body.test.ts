import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_JSON_BODY_BYTES, readJsonBody } from '../src/lib/json_body';
import { SESSION_HEADERS } from '../src/lib/session';

const lib = vi.hoisted(() => ({
  createJob: vi.fn(),
  enhancePrompt: vi.fn(),
  createUpload: vi.fn(),
  completeOnboarding: vi.fn(),
  createReport: vi.fn(),
  recordTtfi: vi.fn(),
}));

vi.mock('../src/lib/jobs', async (original) => ({
  ...(await original<typeof import('../src/lib/jobs')>()),
  createJob: lib.createJob,
}));
vi.mock('../src/lib/jobs_deps', () => ({ jobsDeps: () => ({}) }));
vi.mock('../src/lib/enhance', () => ({ enhancePrompt: lib.enhancePrompt }));
vi.mock('../src/lib/enhance_deps', () => ({ enhanceDeps: () => ({}) }));
vi.mock('../src/lib/uploads', () => ({ createUpload: lib.createUpload }));
vi.mock('../src/lib/uploads_deps', () => ({ uploadsDeps: () => ({}) }));
vi.mock('../src/lib/account', () => ({ completeOnboarding: lib.completeOnboarding }));
vi.mock('../src/lib/account_deps', () => ({ accountDeps: () => ({}) }));
vi.mock('../src/lib/reports', () => ({ createReport: lib.createReport }));
vi.mock('../src/lib/ttfi', () => ({ recordTtfi: lib.recordTtfi }));
vi.mock('../src/lib/dynamodb', () => ({
  documentClient: () => ({}),
  tableName: () => 'pictora-test',
}));

const { POST: jobs } = await import('../src/app/api/jobs/route');
const { POST: enhance } = await import('../src/app/api/enhance/route');
const { POST: uploads } = await import('../src/app/api/uploads/route');
const { POST: onboarding } = await import('../src/app/api/me/onboarding/route');
const { POST: reports } = await import('../src/app/api/reports/route');
const { POST: ttfi } = await import('../src/app/api/metrics/ttfi/route');

const URL_BASE = 'https://pictora.example.dev';

/** A JSON body of exactly `bytes` bytes. */
function bodyOf(bytes: number): string {
  const padding = bytes - JSON.stringify({ prompt: '' }).length;
  return JSON.stringify({ prompt: 'a'.repeat(padding) });
}

/** A body sent in chunks with no `Content-Length`, as a chunked upload would arrive. */
function chunked(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        controller.enqueue(bytes.slice(offset, offset + 1024));
      }
      controller.close();
    },
  });
}

describe('readJsonBody', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request(URL_BASE, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

  it('reads a body of up to 16 KB', async () => {
    expect(bodyOf(MAX_JSON_BODY_BYTES)).toHaveLength(MAX_JSON_BODY_BYTES);
    const result = await readJsonBody(post(bodyOf(MAX_JSON_BODY_BYTES)));
    expect(result.ok).toBe(true);
    expect(await readJsonBody(post('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
  });

  it('answers 413 for a larger body, by its Content-Length', async () => {
    const result = await readJsonBody(post(bodyOf(MAX_JSON_BODY_BYTES + 1)));
    expect(result).toEqual({
      ok: false,
      error: {
        status: 413,
        body: { code: 'payload_too_large', error: 'The request is too large.' },
      },
    });
  });

  it('answers 413 for a chunked body without a Content-Length once it passes 16 KB', async () => {
    const request = post(chunked(bodyOf(MAX_JSON_BODY_BYTES * 4)));
    expect(request.headers.get('content-length')).toBeNull();
    expect(await readJsonBody(request)).toMatchObject({ ok: false, error: { status: 413 } });
  });

  it('answers 400 for a body that is not JSON, or is empty', async () => {
    expect(await readJsonBody(post('not json'))).toMatchObject({
      ok: false,
      error: { status: 400, body: { code: 'invalid_request' } },
    });
    expect(await readJsonBody(post(''))).toMatchObject({ ok: false, error: { status: 400 } });
  });
});

describe('JSON routes', () => {
  const signedIn = { [SESSION_HEADERS.sub]: 'user-sub', [SESSION_HEADERS.email]: 'u@example.com' };

  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['POST /api/jobs', jobs, lib.createJob],
    ['POST /api/enhance', enhance, lib.enhancePrompt],
    ['POST /api/uploads', uploads, lib.createUpload],
    ['POST /api/me/onboarding', onboarding, lib.completeOnboarding],
    ['POST /api/reports', reports, lib.createReport],
    ['POST /api/metrics/ttfi', ttfi, lib.recordTtfi],
  ] as const)('%s refuses a body over 16 KB before handling it', async (_name, handler, handle) => {
    const response = await handler(
      new NextRequest(`${URL_BASE}/api/x`, {
        method: 'POST',
        headers: signedIn,
        body: bodyOf(MAX_JSON_BODY_BYTES + 1),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'payload_too_large' });
    expect(handle).not.toHaveBeenCalled();
  });
});
