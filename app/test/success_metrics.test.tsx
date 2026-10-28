// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuccessMetrics } from '../src/components/success_metrics';
import { formatTarget, seconds } from '../src/lib/metrics_format';
import { metricsBody } from './metrics_fixtures';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SuccessMetrics', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function renderWith(body: unknown, status = 200, range = {}) {
    const fetchMock = vi.fn(async () => json(body, status));
    vi.stubGlobal('fetch', fetchMock);
    render(<SuccessMetrics range={range} />);
    return fetchMock;
  }

  it('shows every PRD metric over the range against its target, in green or red with words', async () => {
    await renderWith(metricsBody());
    const tiles = await screen.findByRole('list', { name: 'Success metrics over the range' });
    const text = within(tiles)
      .getAllByRole('listitem')
      .map((tile) => tile.textContent);
    expect(text).toEqual([
      'Activation70.0%Target ≥ 70.0% · Meets target',
      'Keep rate25.0%Target ≥ 35.0% · Misses target',
      'Time to first image (p50)47.5 sTarget < 60.0 s · Meets target',
      'Generation success90.0%Target ≥ 98.0% · Misses target',
      'Week-1 retention—Target ≥ 25.0% · No data yet',
      'Cost per active user$1.75Target ≤ $1.75 · Meets target',
      'Moderation false blocks1.0%Target < 2.0% · Meets target',
    ]);
    expect(screen.getByTestId('metric-activation').dataset.status).toBe('met');
    expect(screen.getByTestId('metric-keepRate').dataset.status).toBe('missed');
    expect(screen.getByTestId('metric-weekOneRetention').dataset.status).toBe('none');
    // Green for met and red for missed, from the theme in both light and dark.
    expect(
      within(screen.getByTestId('metric-activation')).getByText('Meets target').className,
    ).toContain('text-green-700');
    expect(
      within(screen.getByTestId('metric-keepRate')).getByText('Misses target').className,
    ).toContain('text-destructive');
    expect(screen.getByText(/last at 2026-10-15 00:30 UTC/)).toBeTruthy();
  });

  it('lists each day, with days not computed yet as pending', async () => {
    await renderWith(metricsBody());
    const table = await screen.findByRole('table', { name: 'Success metrics by day' });
    const [, computed, pending] = within(table).getAllByRole('row');
    const cells = within(computed!).getAllByRole('cell');
    expect(cells.map((cell) => cell.textContent)).toEqual([
      '70.0%, meets target',
      '—',
      '47.5 s, meets target',
      '98.0%, meets target',
      '—',
      '$1.75, meets target',
      '1.0%, meets target',
    ]);
    expect(cells.map((cell) => cell.dataset.status)).toEqual([
      'met',
      'none',
      'met',
      'met',
      'none',
      'met',
      'met',
    ]);
    expect(cells[0]?.className).toContain('text-green-700');
    expect(
      within(pending!)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(Array(7).fill('Pending'));
    expect(within(pending!).getAllByRole('cell')[0]?.dataset.status).toBe('pending');
  });

  it('asks for the range it is given, and shows an API error', async () => {
    const fetchMock = await renderWith(
      { error: 'Pick a range of at most 92 days.', code: 'invalid_request' },
      400,
      { from: '2026-01-01', to: '2026-10-15' },
    );
    expect((await screen.findByRole('alert')).textContent).toBe('Pick a range of at most 92 days.');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/metrics?from=2026-01-01&to=2026-10-15', {
      cache: 'no-store',
    });
  });
});

describe('metric formats', () => {
  it('writes targets with their comparison and unit', () => {
    expect(seconds(59_950)).toBe('60.0 s');
    expect(formatTarget('falseBlocks', { comparison: 'below', bound: 0.02 })).toBe('< 2.0%');
    expect(formatTarget('costPerActiveUser', { comparison: 'atMost', bound: 175 })).toBe('≤ $1.75');
  });
});
