import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../src/app/api/health/route';

describe('GET /api/health', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns ok with the commit sha from GIT_SHA', async () => {
    vi.stubEnv('GIT_SHA', 'abc123');

    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', sha: 'abc123' });
  });

  it('defaults the sha to local when GIT_SHA is unset', async () => {
    vi.stubEnv('GIT_SHA', undefined);

    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', sha: 'local' });
  });
});
