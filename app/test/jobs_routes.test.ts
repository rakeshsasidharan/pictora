import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET } from '../src/app/api/jobs/[id]/route';
import { POST } from '../src/app/api/jobs/route';
import { GET as getImage } from '../src/app/api/images/[id]/route';
import { SESSION_HEADERS } from '../src/lib/session';

const url = 'https://pictora.example.dev/api/jobs';
const signedIn = { [SESSION_HEADERS.sub]: 'user-sub', [SESSION_HEADERS.email]: 'u@example.com' };

describe('POST /api/jobs', () => {
  it('answers 401 without a session', async () => {
    const response = await POST(new NextRequest(url, { method: 'POST', body: '{}' }));
    expect(response.status).toBe(401);
  });

  it('answers 400 when the body is not JSON', async () => {
    const response = await POST(
      new NextRequest(url, { method: 'POST', body: 'not json', headers: signedIn }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'invalid_request',
      error: 'The request body must be JSON.',
    });
  });
});

describe('GET /api/jobs/:id', () => {
  it('answers 401 without a session', async () => {
    const response = await GET(new NextRequest(`${url}/01JAAAAAAAAAAAAAAAAAAAAAAA`), {
      params: Promise.resolve({ id: '01JAAAAAAAAAAAAAAAAAAAAAAA' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('GET /api/images/:id', () => {
  it('answers 401 without a session', async () => {
    const id = '01JAAAAAAAAAAAAAAAAAAAAAAA';
    const response = await getImage(
      new NextRequest(`https://pictora.example.dev/api/images/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(401);
  });
});
