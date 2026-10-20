import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLog,
  hashUserSub,
  metricsNamespace,
  powertoolsMetrics,
  redactPrompts,
  type LogSink,
} from '../src/observability.js';

function fakeSink() {
  const lines: { level: string; message: string; extra: Record<string, unknown> }[] = [];
  const record =
    (level: string) =>
    (message: string, extra: Record<string, unknown> = {}) =>
      lines.push({ level, message, extra });
  const sink = {
    debug: record('DEBUG'),
    info: record('INFO'),
    warn: record('WARN'),
    error: record('ERROR'),
  } as unknown as LogSink;
  return { sink, lines };
}

describe('log redaction', () => {
  const fields = {
    jobId: 'J1',
    prompt: 'my secret idea',
    enhancedPrompt: 'a richer secret idea',
    sentPrompt: 'a richer secret idea, watercolour',
    avoid: 'people',
    instruction: 'make it red',
    modelId: 'gpt-image-2',
  };

  it('drops prompts at info, warn and error level', () => {
    for (const level of ['INFO', 'WARN', 'ERROR'] as const) {
      expect(redactPrompts(level, fields)).toEqual({ jobId: 'J1', modelId: 'gpt-image-2' });
    }
  });

  it('keeps them at debug level', () => {
    expect(redactPrompts('DEBUG', fields)).toEqual(fields);
  });

  it('never writes a prompt or a raw sub in an info line', () => {
    const { sink, lines } = fakeSink();
    const log = createLog('worker', sink);
    log('INFO', 'Job succeeded', {
      ...fields,
      userSub: 'user-sub-123',
      provider: 'openai',
      latencyMs: 1200,
      costCents: 4,
      outcome: 'succeeded',
    });
    expect(lines).toEqual([
      {
        level: 'INFO',
        message: 'Job succeeded',
        extra: {
          jobId: 'J1',
          modelId: 'gpt-image-2',
          userSub: hashUserSub('user-sub-123'),
          provider: 'openai',
          latencyMs: 1200,
          costCents: 4,
          outcome: 'succeeded',
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('secret');
    expect(JSON.stringify(lines)).not.toContain('user-sub-123');
  });

  it('reduces an error to its message', () => {
    const { sink, lines } = fakeSink();
    createLog('app', sink)('ERROR', 'Enqueue failed', { error: new Error('SQS down') });
    createLog('app', sink)('WARN', 'Odd', { error: 'plain' });
    expect(lines.map((line) => line.extra.error)).toEqual(['SQS down', 'plain']);
  });
});

describe('hashUserSub', () => {
  it('is short, stable and distinct per user', () => {
    expect(hashUserSub('a')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashUserSub('a')).toBe(hashUserSub('a'));
    expect(hashUserSub('a')).not.toBe(hashUserSub('b'));
  });
});

describe('powertoolsMetrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('publishes EMF lines in Pictora/<env>, with provider metrics on their own', () => {
    vi.stubEnv('POWERTOOLS_DEV', 'true');
    vi.stubEnv('POWERTOOLS_METRICS_DISABLED', 'false');
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const emit = powertoolsMetrics({ PICTORA_ENV: 'dev' });
    emit([
      { name: 'JobsSucceeded', value: 1, unit: 'Count' },
      { name: 'ProviderCostCents', value: 4, unit: 'Count' },
      {
        name: 'ProviderLatencyMs',
        value: 1500,
        unit: 'Milliseconds',
        dimensions: { provider: 'openai' },
      },
    ]);
    const lines = out.mock.calls.map(([line]) => JSON.parse(String(line)));
    const latency = lines.find((line) => 'ProviderLatencyMs' in line);
    expect(latency).toMatchObject({
      service: 'pictora',
      provider: 'openai',
      ProviderLatencyMs: 1500,
    });
    expect(latency._aws.CloudWatchMetrics[0]).toMatchObject({
      Namespace: 'Pictora/dev',
      Dimensions: [['service', 'provider']],
    });
    const jobs = lines.find((line) => 'JobsSucceeded' in line);
    expect(jobs).toMatchObject({ service: 'pictora', JobsSucceeded: 1, ProviderCostCents: 4 });
    expect(jobs._aws.CloudWatchMetrics[0].Dimensions).toEqual([['service']]);
  });

  it('names the namespace per environment', () => {
    expect(metricsNamespace('prod')).toBe('Pictora/prod');
  });
});
