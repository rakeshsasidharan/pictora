// @vitest-environment jsdom
import { loadSeedRegistry } from '@pictora/core';
import { createRegistryLoader } from '@pictora/core/registry-store';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageDetailBody } from '../src/lib/images';
import { SESSION_HEADERS } from '../src/lib/session';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
const onboarded = vi.hoisted(() => ({ current: true }));
const detail = vi.hoisted(() => ({
  current: undefined as { status: number; body: Record<string, unknown> } | undefined,
}));

vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect to ${url}`);
  }
}

class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  notFound: () => {
    throw new NotFoundSignal('not found');
  },
}));

vi.mock('../src/lib/onboarding', () => ({
  requireOnboarding: async () => {
    if (!onboarded.current) throw new RedirectSignal('/onboarding');
  },
}));

vi.mock('../src/lib/registry', () => ({
  registryLoader: () =>
    createRegistryLoader({ source: async () => loadSeedRegistry(), environment: 'dev' }),
}));

vi.mock('../src/lib/jobs_deps', () => ({
  jobsDeps: () => ({ hasQueue: (provider: string) => provider !== 'bedrock', spendCapCents: 2000 }),
}));

vi.mock('../src/lib/dynamodb', () => ({
  documentClient: () => ({}),
  tableName: () => 'pictora-test',
}));

vi.mock('../src/lib/platform_spend', () => ({ readPremiumPause: async () => undefined }));

vi.mock('../src/lib/jobs', () => ({
  getMe: async () => ({ status: 200, body: { pointsLeft: 19, dailyLimit: 25 } }),
}));

vi.mock('../src/lib/images', () => ({ getImageDetail: async () => detail.current }));

const { default: EditImagePage } = await import('../src/app/edit/[imageId]/page');

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

function body(): ImageDetailBody {
  const version = (n: number) => ({
    version: n,
    width: 64,
    height: 64,
    url: `https://signed.example/v${n}.png`,
    downloadUrl: `https://signed.example/v${n}.png?download`,
    thumbUrl: `https://signed.example/v${n}.webp`,
    ...(n > 1 ? { parentVersion: n - 1, editInstruction: `Edit ${n}` } : { prompt: 'A fox' }),
  });
  return {
    image: { imageId: IMAGE_ID, title: 'A fox', latestVersion: 2, versionCount: 2 },
    versions: [version(1), version(2)],
  };
}

const page = (version?: string) =>
  EditImagePage({
    params: Promise.resolve({ imageId: IMAGE_ID }),
    searchParams: Promise.resolve(version ? { version } : {}),
  });

describe('edit image page', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers({
      [SESSION_HEADERS.sub]: 'user-sub',
      [SESSION_HEADERS.email]: 'user@example.com',
    });
    onboarded.current = true;
    detail.current = { status: 200, body: { ...body() } };
  });
  afterEach(cleanup);

  it('shows the panel with the edit models that have a queue and today’s points', async () => {
    render(await page());
    expect(screen.getByRole('heading', { level: 1, name: 'Edit image' })).toBeTruthy();
    expect(screen.getByText('19 of 25 points left today')).toBeTruthy();
    const options = within(screen.getByRole('combobox', { name: 'Model' }))
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(options).toContain('mock');
    expect(options).not.toContain('stable-image-core');
    expect(screen.getByRole('button', { name: 'Version 2' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('starts from the version in the query', async () => {
    render(await page('1'));
    expect(screen.getByRole('button', { name: 'Version 1' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it("is a 404 for an image that isn't the user's", async () => {
    detail.current = { status: 404, body: { code: 'not_found' } };
    await expect(page()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('sends signed-out visitors home and new users to onboarding', async () => {
    onboarded.current = false;
    await expect(page()).rejects.toMatchObject({ url: '/onboarding' });
    requestHeaders.current = new Headers();
    await expect(page()).rejects.toMatchObject({ url: '/' });
  });
});
