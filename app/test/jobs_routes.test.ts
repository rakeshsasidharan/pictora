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

describe('admin routes', () => {
  const admin = { ...signedIn, [SESSION_HEADERS.groups]: 'testers' };

  it('answer 401 without a session and 403 to non-admins', async () => {
    const { GET: stats } = await import('../src/app/api/admin/stats/route');
    const { GET: moderation } = await import('../src/app/api/admin/moderation/route');
    const { POST: suspend } = await import('../src/app/api/admin/users/[sub]/suspend/route');
    const base = 'https://pictora.example.dev/api/admin';
    expect((await stats(new NextRequest(`${base}/stats`))).status).toBe(401);
    expect((await stats(new NextRequest(`${base}/stats`, { headers: admin }))).status).toBe(403);
    expect(
      (await moderation(new NextRequest(`${base}/moderation`, { headers: admin }))).status,
    ).toBe(403);
    const response = await suspend(
      new NextRequest(`${base}/users/x/suspend`, { method: 'POST', headers: admin }),
      { params: Promise.resolve({ sub: 'x' }) },
    );
    expect(response.status).toBe(403);
  });
});
