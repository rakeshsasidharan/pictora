import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../src/app/api/enhance/route';
import { enhanceDeps } from '../src/lib/enhance_deps';
import { SESSION_HEADERS } from '../src/lib/session';

const url = 'https://pictora.example.dev/api/enhance';
const signedIn = { [SESSION_HEADERS.sub]: 'user-sub', [SESSION_HEADERS.email]: 'u@example.com' };

describe('POST /api/enhance', () => {
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

describe('enhanceDeps', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('needs a valid ENHANCER_MODEL and the secrets its backend uses', () => {
    vi.stubEnv('TABLE_NAME', 'pictora-dev');
    vi.stubEnv('ENHANCER_MODEL', 'openai:gpt-5');
    expect(() => enhanceDeps()).toThrow(/ENHANCER_MODEL must be/);

    vi.stubEnv('ENHANCER_MODEL', 'mock');
    vi.stubEnv('OPENAI_SECRET_ID', 'pictora/dev/openai');
    expect(enhanceDeps()).toMatchObject({ tableName: 'pictora-dev', enhancerModel: 'mock' });
  });
});
