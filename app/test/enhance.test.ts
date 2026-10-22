import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  PROFILE_SK,
  RATE_LIMIT_PER_MINUTE,
  TESTER_RATE_LIMIT_PER_MINUTE,
  TESTERS_GROUP,
  TOS_VERSION,
  loadSeedRegistry,
  rateSk,
  statsEnhancerSk,
  statsPk,
  userPk,
  utcMinute,
  type ModerationResult,
} from '@pictora/core';
import type { EmitMetrics } from '@pictora/core/observability';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import type { Enhance, Moderate } from '@pictora/providers/text';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enhancePrompt, takeRateSlot, type EnhanceDeps } from '../src/lib/enhance';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const devModels = modelsAvailableIn(loadSeedRegistry(), 'dev');

const ONBOARDED = {
  tosAcceptedAt: '2026-10-14T09:00:00.000Z',
  tosVersion: TOS_VERSION,
  ageConfirmed: true,
};

const ENHANCED =
  'A lighthouse on a rocky headland at dusk, waves breaking below, warm lamp glow against a violet sky';

const clean: ModerationResult = { flagged: false, categories: {} };
const sexual: ModerationResult = { flagged: true, categories: { sexual: true } };

let sessionCounter = 0;
function newSession(): Session {
  sessionCounter += 1;
  return { sub: `enh-${sessionCounter}-${Date.now()}`, email: 'user@example.com', groups: [] };
}

const request = { prompt: '  a lighthouse at dusk ', style: 'watercolour', modelId: 'gpt-image-2' };

describe('enhancePrompt: request checks', () => {
  const offline = (overrides: Partial<EnhanceDeps> = {}): EnhanceDeps => ({
    client: {
      send: () => Promise.reject(new Error('DynamoDB should not be called')),
    } as unknown as EnhanceDeps['client'],
    tableName: 'unused',
    models: async () => devModels,
    moderate: vi.fn<Moderate>(async () => clean),
    enhance: vi.fn<Enhance>(),
    enhancerModel: 'mock',
    now: () => new Date('2026-10-15T12:00:00Z'),
    ...overrides,
  });

  it.each([
    {},
    { ...request, prompt: '' },
    { ...request, prompt: 'x'.repeat(2001) },
    { ...request, style: 'cubism' },
    { ...request, extra: true },
  ])('rejects an invalid request: %j', async (input) => {
    const result = await enhancePrompt(offline(), newSession(), input);
    expect(result).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
  });

  it('rejects an unknown model', async () => {
    const result = await enhancePrompt(offline(), newSession(), { ...request, modelId: 'nope' });
    expect(result).toMatchObject({ status: 400, body: { code: 'unknown_model' } });
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('enhancePrompt against DynamoDB Local', () => {
  const table = localTable('pictora-enhance-test');
  const { client, tableName } = table;
  const now = new Date('2026-10-15T12:00:00Z');
  let moderate: ReturnType<typeof vi.fn<Moderate>>;
  let enhance: ReturnType<typeof vi.fn<Enhance>>;

  const deps = (overrides: Partial<EnhanceDeps> = {}): EnhanceDeps => ({
    client,
    tableName,
    models: async () => devModels,
    moderate,
    enhance,
    enhancerModel: 'bedrock:us.openai.gpt-5.6-luna',
    now: () => now,
    ...overrides,
  });

  const getItem = async (PK: string, SK: string) =>
    (await client.send(new GetCommand({ TableName: tableName, Key: { PK, SK } }))).Item;
  const stats = () =>
    getItem(statsPk('2026-10-15'), statsEnhancerSk('bedrock:us.openai.gpt-5.6-luna'));
  const setProfile = async (sub: string, fields: Record<string, unknown>) => {
    const names = Object.keys(fields);
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: PROFILE_SK },
        UpdateExpression: `SET ${names.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
        ExpressionAttributeNames: Object.fromEntries(names.map((name, i) => [`#k${i}`, name])),
        ExpressionAttributeValues: Object.fromEntries(
          names.map((name, i) => [`:v${i}`, fields[name]]),
        ),
      }),
    );
  };
  const onboardedSession = async (): Promise<Session> => {
    const session = newSession();
    await setProfile(session.sub, ONBOARDED);
    return session;
  };

  beforeAll(() => table.create());
  afterAll(() => table.drop());
  beforeEach(() => {
    moderate = vi.fn<Moderate>(async () => clean);
    enhance = vi.fn<Enhance>(async () => ({
      enhancedPrompt: ENHANCED,
      inputTokens: 400,
      outputTokens: 150,
      costCents: 0.03,
      latencyMs: 900,
    }));
  });

  it('moderates the input, enhances it for the model and style, moderates the output', async () => {
    const before = await stats();
    const metrics = vi.fn<EmitMetrics>();
    const result = await enhancePrompt(deps({ metrics }), await onboardedSession(), request);
    expect(metrics).toHaveBeenCalledWith([
      { name: 'EnhancerLatencyMs', value: 900, unit: 'Milliseconds' },
    ]);

    expect(result).toEqual({ status: 200, body: { enhancedPrompt: ENHANCED } });
    expect(moderate.mock.calls.map(([input]) => input)).toEqual([
      { text: 'a lighthouse at dusk' },
      { text: ENHANCED },
    ]);
    expect(enhance).toHaveBeenCalledWith({
      prompt: 'a lighthouse at dusk',
      styleText: expect.stringMatching(/^watercolour painting/),
      model: expect.objectContaining({ id: 'gpt-image-2', displayName: 'GPT Image 2' }),
    });
    // The overhead lands in the day's stats, and the user is charged nothing.
    expect(await stats()).toMatchObject({
      calls: (before?.calls ?? 0) + 1,
      inputTokens: (before?.inputTokens ?? 0) + 400,
      outputTokens: (before?.outputTokens ?? 0) + 150,
      costCents: (before?.costCents ?? 0) + 0.03,
    });
  });

  it('needs onboarding first, and refuses suspended accounts and cooldowns', async () => {
    const fresh = newSession();
    expect(await enhancePrompt(deps(), fresh, request)).toMatchObject({
      status: 403,
      body: { code: 'onboarding_required' },
    });

    const suspended = await onboardedSession();
    await setProfile(suspended.sub, { status: 'suspended' });
    expect(await enhancePrompt(deps(), suspended, request)).toMatchObject({
      status: 403,
      body: { code: 'suspended' },
    });

    const cooling = await onboardedSession();
    await setProfile(cooling.sub, { cooldownUntil: '2026-10-16T09:00:00.000Z' });
    expect(await enhancePrompt(deps(), cooling, request)).toMatchObject({
      status: 403,
      body: { code: 'cooldown' },
    });
    expect(enhance).not.toHaveBeenCalled();
  });

  it('blocks a flagged prompt without calling the enhancer', async () => {
    moderate.mockResolvedValueOnce(sexual);
    const result = await enhancePrompt(deps(), await onboardedSession(), request);
    expect(result).toMatchObject({ status: 422, body: { code: 'blocked' } });
    expect(result.body.error).toMatch(/content policy/);
    expect(enhance).not.toHaveBeenCalled();
  });

  it('allows categories Pictora does not block, such as plain violence', async () => {
    moderate.mockResolvedValueOnce({ flagged: true, categories: { violence: true } });
    const result = await enhancePrompt(deps(), await onboardedSession(), request);
    expect(result.status).toBe(200);
  });

  it('falls back to the user words when the output is flagged', async () => {
    moderate.mockResolvedValueOnce(clean).mockResolvedValueOnce(sexual);
    const before = await stats();
    const result = await enhancePrompt(deps(), await onboardedSession(), request);
    expect(result).toEqual({
      status: 200,
      body: { enhancedPrompt: 'a lighthouse at dusk', fallback: true },
    });
    expect((await stats())?.fallbacks).toBe((before?.fallbacks ?? 0) + 1);
  });

  it('falls back to the user words when the output check fails', async () => {
    moderate.mockResolvedValueOnce(clean).mockRejectedValueOnce(new Error('HTTP 503'));
    const result = await enhancePrompt(deps(), await onboardedSession(), request);
    expect(result.body).toEqual({ enhancedPrompt: 'a lighthouse at dusk', fallback: true });
  });

  it('answers 503 when the input check or the enhancer fails, counting the failure', async () => {
    moderate.mockRejectedValueOnce(new Error('HTTP 503'));
    const unchecked = await enhancePrompt(deps(), await onboardedSession(), request);
    expect(unchecked).toMatchObject({ status: 503, body: { code: 'enhance_failed' } });
    expect(enhance).not.toHaveBeenCalled();

    const before = await stats();
    enhance.mockRejectedValueOnce(new Error('ThrottlingException'));
    const failed = await enhancePrompt(deps(), await onboardedSession(), request);
    expect(failed).toMatchObject({ status: 503, body: { code: 'enhance_failed' } });
    expect(failed.body.error).toMatch(/your own words will be used/);
    expect((await stats())?.failures).toBe((before?.failures ?? 0) + 1);
  });

  it('shares the job rate window: the 11th request in a minute is refused', async () => {
    const session = await onboardedSession();
    for (let index = 0; index < RATE_LIMIT_PER_MINUTE; index++) {
      expect((await enhancePrompt(deps(), session, request)).status).toBe(200);
    }
    expect(await enhancePrompt(deps(), session, request)).toMatchObject({
      status: 429,
      body: { code: 'rate_limited' },
    });
    expect(enhance).toHaveBeenCalledTimes(RATE_LIMIT_PER_MINUTE);
    expect(await getItem(userPk(session.sub), rateSk(utcMinute(now)))).toMatchObject({
      count: RATE_LIMIT_PER_MINUTE,
    });
  });

  it('gives the testers group 50 requests a minute in the shared window', async () => {
    const session = { ...(await onboardedSession()), groups: [TESTERS_GROUP] };
    for (let index = 0; index < TESTER_RATE_LIMIT_PER_MINUTE; index++) {
      expect((await enhancePrompt(deps(), session, request)).status).toBe(200);
    }
    const refused = await enhancePrompt(deps(), session, request);
    expect(refused).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    expect(refused.body.error).toMatch(/^You've made 50 requests in the last minute/);
  });

  it('takes a slot in a fresh minute again', async () => {
    const sub = newSession().sub;
    const max = RATE_LIMIT_PER_MINUTE;
    for (let index = 0; index < max; index++) {
      await takeRateSlot(client, tableName, sub, now, max);
    }
    expect(await takeRateSlot(client, tableName, sub, now, max)).toBe(false);
    expect(await takeRateSlot(client, tableName, sub, new Date('2026-10-15T12:01:00Z'), max)).toBe(
      true,
    );
  });

  it('keeps working when the stats write fails', async () => {
    const session = await onboardedSession();
    const failingStats = {
      send: (command: unknown) => {
        const key = (command as { input?: { Key?: { PK?: string } } }).input?.Key?.PK ?? '';
        return key.startsWith('STATS#')
          ? Promise.reject(new Error('ProvisionedThroughputExceeded'))
          : client.send(command as never);
      },
    } as unknown as EnhanceDeps['client'];
    const result = await enhancePrompt(deps({ client: failingStats }), session, request);
    expect(result).toEqual({ status: 200, body: { enhancedPrompt: ENHANCED } });
  });
});
