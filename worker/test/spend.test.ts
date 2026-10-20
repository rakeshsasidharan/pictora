import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportMonthlySpend, spendMetricLine } from '../src/spend.js';

describe('spendMetricLine', () => {
  it('is an Embedded Metric Format line with no dimensions', () => {
    const line = JSON.parse(spendMetricLine('Pictora/prod', 8123, new Date(1_000)));
    expect(line).toEqual({
      _aws: {
        Timestamp: 1_000,
        CloudWatchMetrics: [
          {
            Namespace: 'Pictora/prod',
            Dimensions: [[]],
            Metrics: [{ Name: 'MonthlySpendCents', Unit: 'Count' }],
          },
        ],
      },
      MonthlySpendCents: 8123,
    });
  });
});

describe('reportMonthlySpend', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a warning instead of throwing when DynamoDB fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = {
      send: vi.fn(async () => {
        throw new Error('throttled');
      }),
    } as unknown as DynamoDBDocumentClient;

    await expect(
      reportMonthlySpend(
        { client, tableName: 'pictora-dev' },
        { capCents: 2000, namespace: 'Pictora/dev' },
        new Date('2026-10-19T00:00:00Z'),
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Monthly spend not reported'));
    expect(log).not.toHaveBeenCalled();
  });
});
