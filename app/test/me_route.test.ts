import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET } from '../src/app/api/me/route';
import { SESSION_HEADERS } from '../src/lib/session';

describe('GET /api/me', () => {
  it('answers 401 without a session', async () => {
    const response = GET(new NextRequest('https://pictora.example.dev/api/me'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it("returns the signed-in user's email and sub", async () => {
    const response = GET(
      new NextRequest('https://pictora.example.dev/api/me', {
        headers: {
          [SESSION_HEADERS.sub]: 'user-sub',
          [SESSION_HEADERS.email]: 'user@example.com',
          [SESSION_HEADERS.groups]: '',
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: 'user-sub', email: 'user@example.com' });
  });
});
