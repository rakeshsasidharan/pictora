import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET } from '../src/app/api/me/route';

describe('GET /api/me', () => {
  it('answers 401 without a session', async () => {
    const response = await GET(new NextRequest('https://pictora.example.dev/api/me'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
});
