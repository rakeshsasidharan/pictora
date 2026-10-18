// @vitest-environment jsdom
import { loadSeedRegistry } from '@pictora/core';
import { createRegistryLoader } from '@pictora/core/registry-store';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEADERS } from '../src/lib/session';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
const onboarded = vi.hoisted(() => ({ current: true }));

vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect to ${url}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

vi.mock('../src/lib/onboarding', () => ({
  requireOnboarding: async () => {
    if (!onboarded.current) throw new RedirectSignal('/onboarding');
  },
}));

// Dev's registry; Bedrock has no queue yet, so its models are left out.
vi.mock('../src/lib/registry', () => ({
  registryLoader: () =>
    createRegistryLoader({ source: async () => loadSeedRegistry(), environment: 'dev' }),
}));

vi.mock('../src/lib/jobs_deps', () => ({
  jobsDeps: () => ({ hasQueue: (provider: string) => provider !== 'bedrock' }),
}));

vi.mock('../src/lib/jobs', () => ({
  getMe: async () => ({ status: 200, body: { pointsLeft: 19, dailyLimit: 25 } }),
}));

const { default: GeneratePage } = await import('../src/app/generate/page');

function signIn() {
  requestHeaders.current = new Headers({
    [SESSION_HEADERS.sub]: 'user-sub',
    [SESSION_HEADERS.email]: 'user@example.com',
  });
}

describe('generate page', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers();
    onboarded.current = true;
  });
  afterEach(cleanup);

  it('shows the form with the models that have a queue and today’s points', async () => {
    signIn();
    render(await GeneratePage());
    expect(screen.getByRole('heading', { level: 1, name: 'Create an image' })).toBeTruthy();
    expect(screen.getByText('19 of 25 points left today')).toBeTruthy();
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByRole('radio', { name: /^Mock/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^GPT Image 2/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Stable Image Core/ })).toBeNull();
  });

  it('sends users who have not accepted the current terms to onboarding', async () => {
    signIn();
    onboarded.current = false;
    await expect(GeneratePage()).rejects.toMatchObject({ url: '/onboarding' });
  });

  it('sends signed-out visitors home', async () => {
    await expect(GeneratePage()).rejects.toMatchObject({ url: '/' });
  });
});
