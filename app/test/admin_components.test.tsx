// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminDashboard } from '../src/components/admin_dashboard';
import { AdminUser } from '../src/components/admin_user';
import { ModerationReview } from '../src/components/moderation_review';
import type { ModerationEntry } from '../src/lib/admin_moderation';
import type { AdminStatsBody } from '../src/lib/admin_stats';
import { metricsBody } from './metrics_fixtures';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stats(overrides: Partial<AdminStatsBody> = {}): AdminStatsBody {
  return {
    from: '2026-10-14',
    to: '2026-10-15',
    providers: ['openai', 'gemini'],
    days: [
      {
        date: '2026-10-14',
        spendCents: { openai: 17, gemini: 13 },
        enhancerCostCents: 0,
        images: 5,
        failures: 1,
        blocks: 1,
      },
      {
        date: '2026-10-15',
        spendCents: { gemini: 26 },
        enhancerCostCents: 2,
        images: 4,
        failures: 0,
        blocks: 0,
      },
    ],
    models: [
      {
        modelId: 'gemini-3.1-flash-image',
        displayName: 'Gemini 3.1 Flash Image',
        provider: 'gemini',
        images: 6,
        points: 42,
        providerCostCents: 39,
        failures: 0,
        blocks: 1,
      },
    ],
    totals: { spendCents: 56, enhancerCostCents: 2, images: 9, points: 60, failures: 1, blocks: 1 },
    today: {
      date: '2026-10-15',
      spendCents: 28,
      images: 4,
      failures: 1,
      blocks: 2,
      failureRate: 0.2,
    },
    month: { month: '2026-10', spentCents: 1500, capCents: 2000 },
    moderation: { blocksReviewed: 4, falseBlocks: 1, reportsReviewed: 0 },
    topUsers: [{ sub: 'heavy', email: 'heavy@example.com', status: 'active', pointsUsed: 24 }],
    ...overrides,
  };
}

/** A fetch that answers the success metrics section with a fixture and everything else with `handle`. */
function withMetrics(handle: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) =>
    url.startsWith('/api/admin/metrics') ? json(metricsBody()) : handle(url, init),
  );
}

describe('AdminDashboard', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows loading, then the KPIs, chart, tables and top users', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = withMetrics(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminDashboard />);
    expect(screen.getByText('Loading stats…').getAttribute('role')).toBe('status');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/stats', { cache: 'no-store' });
    answer(json(stats()));

    const tiles = await screen.findByRole('list', { name: 'Today, 2026-10-15' });
    const tileText = within(tiles)
      .getAllByRole('listitem')
      .map((tile) => tile.textContent);
    expect(tileText).toEqual([
      'Spend today$0.28',
      'Month to date$15.00of $20.00 cap (75.0%)',
      'Images today4',
      'Failure rate today20.0%',
      'Blocks today2',
      'False blocks (reviewed)25.0%1 of 4 reviewed',
    ]);
    expect(screen.getByRole('img', { name: /Daily provider spend/ })).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Providers' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['OpenAI', 'Gemini']);
    const daily = screen.getByRole('table', { name: 'Spend and jobs by day' });
    expect(within(daily).getAllByRole('row')[1]?.textContent).toBe('2026-10-14$0.17$0.13$0.00511');
    expect(within(screen.getByRole('table', { name: 'By model' })).getByText('$0.39')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'heavy@example.com' }).getAttribute('href')).toBe(
      '/admin/users/heavy',
    );
    expect(screen.getByRole('link', { name: 'documented commands' })).toBeTruthy();
    // The success metrics for the same range follow.
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/metrics', { cache: 'no-store' });
    expect(await screen.findByRole('heading', { name: 'Success metrics' })).toBeTruthy();
  });

  it('shows the split for a day on hover', async () => {
    vi.stubGlobal(
      'fetch',
      withMetrics(async () => json(stats())),
    );
    render(<AdminDashboard />);
    const day = await screen.findByRole('button', { name: '2026-10-14: $0.30' });
    fireEvent.mouseEnter(day);
    expect(screen.getByText('2026-10-14: $0.30 — OpenAI $0.17, Gemini $0.13')).toBeTruthy();
  });

  it('says so when the range has nothing, and when nobody used points today', async () => {
    const quiet = stats({
      providers: [],
      days: [
        {
          date: '2026-10-15',
          spendCents: {},
          enhancerCostCents: 0,
          images: 0,
          failures: 0,
          blocks: 0,
        },
      ],
      models: [],
      totals: { spendCents: 0, enhancerCostCents: 0, images: 0, points: 0, failures: 0, blocks: 0 },
      topUsers: [],
    });
    vi.stubGlobal(
      'fetch',
      withMetrics(async () => json(quiet)),
    );
    render(<AdminDashboard />);
    expect(await screen.findByText('No jobs or spend in this range.')).toBeTruthy();
    expect(screen.getByText('Nobody has used points today.')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Daily provider spend/ })).toBeNull();
  });

  it('asks for a new range, and shows the API error', async () => {
    const fetchMock = withMetrics(async (url: string) =>
      url.includes('from=2026-01-01')
        ? json({ error: 'Pick a range of at most 92 days.', code: 'invalid_request' }, 400)
        : json(stats()),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminDashboard />);
    const from = await screen.findByLabelText('From');
    fireEvent.change(from, { target: { value: '2026-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Pick a range of at most 92 days.');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/stats?from=2026-01-01&to=2026-10-15', {
      cache: 'no-store',
    });
    // The metrics section asks for the same range.
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/metrics?from=2026-01-01&to=2026-10-15', {
      cache: 'no-store',
    });
  });
});

const BLOCK: ModerationEntry = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAA1',
  date: '2026-10-15',
  type: 'block',
  userId: 'heavy',
  createdAt: '2026-10-15T09:00:00.000Z',
  promptExcerpt: 'A battle',
  stage: 'prompt',
  category: 'violence/graphic',
};
const REPORT: ModerationEntry = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAA3',
  date: '2026-10-15',
  type: 'report',
  userId: 'middle',
  createdAt: '2026-10-15T11:00:00.000Z',
  promptExcerpt: 'A cat',
  reason: 'other',
  imageId: '01JIMAGEAAAAAAAAAAAAAAAAAA',
  version: 2,
  thumbUrl: 'https://signed.example/thumb.webp',
  review: 'confirmed',
};

describe('ModerationReview', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the entries with their review state and the report thumbnail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ date: '2026-10-15', entries: [REPORT, BLOCK] })),
    );
    render(<ModerationReview initialDate="2026-10-15" />);
    const entries = await screen.findAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(within(entries[0]!).getByText('Report · other')).toBeTruthy();
    expect(within(entries[0]!).getByRole<HTMLImageElement>('img').src).toBe(REPORT.thumbUrl);
    expect(within(entries[0]!).getByText('Reviewed: Confirmed')).toBeTruthy();
    expect(within(entries[1]!).getByText('Block · prompt · violence/graphic')).toBeTruthy();
    expect(within(entries[1]!).getByText('Not reviewed')).toBeTruthy();
    expect(within(entries[1]!).getByRole('link', { name: 'heavy' }).getAttribute('href')).toBe(
      '/admin/users/heavy',
    );
  });

  it('marks an entry as a false block', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? json({ id: BLOCK.id, date: BLOCK.date, review: 'ok' })
        : json({ date: '2026-10-15', entries: [BLOCK] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ModerationReview initialDate="2026-10-15" />);
    fireEvent.click(await screen.findByRole('button', { name: `OK (false block): ${BLOCK.id}` }));
    expect(await screen.findByText('Reviewed: OK (false block)')).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(`/api/admin/moderation/2026-10-15/${BLOCK.id}/review`);
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ verdict: 'ok' });
    expect(
      screen
        .getByRole('button', { name: `OK (false block): ${BLOCK.id}` })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('shows why a review failed, an empty day, and loads another day', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return json({ error: 'Another admin reviewed this entry at the same time.' }, 409);
      }
      return url.endsWith('2026-10-14')
        ? json({ date: '2026-10-14', entries: [] })
        : json({ date: '2026-10-15', entries: [BLOCK] });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ModerationReview initialDate="2026-10-15" />);
    fireEvent.click(await screen.findByRole('button', { name: `Confirmed: ${BLOCK.id}` }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Another admin/);

    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-10-14' } });
    expect(await screen.findByText('No blocks or reports on 2026-10-14.')).toBeTruthy();
  });
});

describe('AdminUser', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const user = {
    sub: 'heavy',
    email: 'heavy@example.com',
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    activeJobs: 0,
    dailyLimit: 25,
    pointsUsedToday: 24,
  };

  it('suspends and unsuspends the user', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/suspend') && init?.method === 'POST') {
        return json({ sub: 'heavy', status: 'suspended' });
      }
      if (url.endsWith('/unsuspend') && init?.method === 'POST') {
        return json({ sub: 'heavy', status: 'active' });
      }
      return json(user);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminUser sub="heavy" />);
    expect(await screen.findByRole('heading', { name: 'heavy@example.com' })).toBeTruthy();
    expect(screen.getByText('24 of 25')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unsuspend' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Suspend' })).toBeTruthy());
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url),
    ).toEqual(['/api/admin/users/heavy/suspend', '/api/admin/users/heavy/unsuspend']);
  });

  it('says when the user is not found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'User not found.' }, 404)),
    );
    render(<AdminUser sub="nobody" />);
    expect((await screen.findByRole('alert')).textContent).toBe('User not found.');
  });
});
