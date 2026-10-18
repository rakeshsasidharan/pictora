import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  JOB_ERROR_MESSAGES,
  JOB_SK,
  PROFILE_SK,
  TOS_VERSION,
  jobPk,
  loadSeedRegistry,
  usageSk,
  userPk,
  type GenerateJobRequest,
  type JobItem,
  type ModelConfig,
} from '@pictora/core';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJob, getJobStatus, getMe, unsupportedOption, type JobsDeps } from '../src/lib/jobs';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const devModels = modelsAvailableIn(loadSeedRegistry(), 'dev');
const model = (id: string): ModelConfig => {
  const found = devModels.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} in the dev registry`);
  return found;
};

/** A generate request for the mock model costing `count` × the quality's points (draft 1, standard 2, high 3). */
function generate(overrides: Partial<GenerateJobRequest> = {}): GenerateJobRequest {
  return {
    type: 'generate',
    prompt: 'A lighthouse at dusk',
    style: 'photorealistic',
    modelId: 'mock',
    aspect: '1:1',
    quality: 'draft',
    count: 1,
    ...overrides,
  };
}

const ONBOARDED = {
  tosAcceptedAt: '2026-10-14T09:00:00.000Z',
  tosVersion: TOS_VERSION,
  ageConfirmed: true,
};

let sessionCounter = 0;
function newSession(): Session {
  sessionCounter += 1;
  return { sub: `user-${sessionCounter}-${Date.now()}`, email: 'user@example.com', groups: [] };
}

/** Deps with no DynamoDB, for checks that answer before any read or write. */
function offlineDeps(overrides: Partial<JobsDeps> = {}): JobsDeps {
  return {
    client: {
      send: () => Promise.reject(new Error('DynamoDB should not be called')),
    } as unknown as JobsDeps['client'],
    tableName: 'unused',
    models: async () => devModels,
    hasQueue: () => true,
    enqueue: async () => undefined,
    presign: async (key, downloadName) =>
      `https://signed.example/${key}${downloadName ? `?download=${downloadName}` : ''}`,
    defaultDailyPoints: 25,
    now: () => new Date('2026-10-15T12:00:00Z'),
    newJobId: () => '01JAAAAAAAAAAAAAAAAAAAAAAA',
    ...overrides,
  };
}

describe('createJob: request checks', () => {
  const session = newSession();

  it('rejects an invalid request with a plain-language message', async () => {
    const result = await createJob(offlineDeps(), session, { type: 'generate', prompt: '' });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'invalid_request' });
    expect(result.body.error).toMatch(/isn't valid/);
  });

  it('rejects edits, which arrive with #22', async () => {
    const result = await createJob(offlineDeps(), session, {
      type: 'edit',
      imageId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
      parentVersion: 1,
      instruction: 'Make it blue',
      modelId: 'mock',
      quality: 'draft',
    });
    expect(result).toMatchObject({ status: 400, body: { code: 'edit_unavailable' } });
  });

  it('rejects a model that is not in the registry', async () => {
    const result = await createJob(offlineDeps(), session, generate({ modelId: 'no-such-model' }));
    expect(result).toMatchObject({ status: 400, body: { code: 'unknown_model' } });
  });

  it('rejects a switched-off model', async () => {
    const deps = offlineDeps({
      models: async () => devModels.map((m) => (m.id === 'mock' ? { ...m, enabled: false } : m)),
    });
    const result = await createJob(deps, session, generate());
    expect(result).toMatchObject({ status: 400, body: { code: 'model_disabled' } });
    expect(result.body.error).toMatch(/Mock \(dev only\) is switched off/);
  });

  it('rejects a model whose provider has no queue', async () => {
    const deps = offlineDeps({ hasQueue: (provider) => provider !== 'mock' });
    const result = await createJob(deps, session, generate());
    expect(result).toMatchObject({ status: 400, body: { code: 'model_disabled' } });
  });

  it('rejects a transparent background on Gemini', async () => {
    const result = await createJob(
      offlineDeps(),
      session,
      generate({
        modelId: 'gemini-3.1-flash-image',
        quality: 'standard',
        transparentBackground: true,
      }),
    );
    expect(result).toMatchObject({ status: 400, body: { code: 'unsupported_option' } });
    expect(result.body.error).toMatch(/transparent backgrounds/);
  });

  it('names each unsupported option', () => {
    const gemini = model('gemini-3.1-flash-image');
    expect(unsupportedOption(gemini, generate({ modelId: gemini.id, quality: 'draft' }))).toMatch(
      /doesn't offer draft quality/,
    );
    expect(
      unsupportedOption(gemini, generate({ modelId: gemini.id, quality: 'standard', seed: 7 })),
    ).toMatch(/fixed seed/);
    const square = {
      ...gemini,
      capabilities: { ...gemini.capabilities, aspects: ['1:1' as const] },
    };
    expect(
      unsupportedOption(
        square,
        generate({ modelId: gemini.id, quality: 'standard', aspect: '16:9' }),
      ),
    ).toMatch(/16:9 aspect ratio/);
    const editOnly = { ...gemini, capabilities: { ...gemini.capabilities, generate: false } };
    expect(unsupportedOption(editOnly, generate({ quality: 'standard' }))).toMatch(
      /can't create new images/,
    );
    expect(
      unsupportedOption(model('mock'), generate({ seed: 7, transparentBackground: true })),
    ).toBe(undefined);
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('job API against DynamoDB Local', () => {
  const table = localTable('pictora-jobs-test');
  const { client, tableName } = table;
  let clock: Date;
  let idCounter: number;
  let enqueue: ReturnType<typeof vi.fn<JobsDeps['enqueue']>>;

  const deps = (overrides: Partial<JobsDeps> = {}): JobsDeps => ({
    client,
    tableName,
    models: async () => devModels,
    hasQueue: () => true,
    enqueue,
    presign: async (key, downloadName) =>
      `https://signed.example/${key}${downloadName ? `?download=${downloadName}` : ''}`,
    defaultDailyPoints: 25,
    now: () => clock,
    newJobId: () => {
      idCounter += 1;
      return `01J${String(idCounter).padStart(23, '0')}`;
    },
    ...overrides,
  });

  const getItem = async (PK: string, SK: string) =>
    (await client.send(new GetCommand({ TableName: tableName, Key: { PK, SK } }))).Item;
  const usedToday = async (sub: string) =>
    (await getItem(userPk(sub), usageSk('2026-10-15')))?.used as number | undefined;
  const profileOf = async (sub: string) => getItem(userPk(sub), PROFILE_SK);
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
  /** A user who has been through onboarding for the current terms (AUTH-4). */
  const onboardedSession = async (): Promise<Session> => {
    const session = newSession();
    await setProfile(session.sub, ONBOARDED);
    return session;
  };
  /** Frees the user's concurrency slots, as the worker does when jobs finish. */
  const finishJobs = (sub: string) => setProfile(sub, { activeJobs: 0 });

  beforeAll(() => table.create());
  afterAll(() => table.drop());
  beforeEach(() => {
    clock = new Date('2026-10-15T12:00:00Z');
    idCounter = Math.floor(Math.random() * 1e9);
    enqueue = vi.fn<JobsDeps['enqueue']>(async () => undefined);
  });

  it('creates the profile, reserves the points, records the queued job and queues it', async () => {
    const session = await onboardedSession();
    const result = await createJob(deps(), session, generate({ quality: 'high', count: 2 }));
    expect(result.status).toBe(202);
    const { jobId } = result.body as { jobId: string };
    expect(result.body).toEqual({ jobId, status: 'queued', pointsReserved: 6 });
    expect(enqueue).toHaveBeenCalledWith('mock', jobId);

    expect(await profileOf(session.sub)).toMatchObject({
      email: 'user@example.com',
      createdAt: '2026-10-15T12:00:00.000Z',
      status: 'active',
      activeJobs: 1,
    });
    expect(await getItem(userPk(session.sub), usageSk('2026-10-15'))).toMatchObject({
      used: 6,
      GSI1PK: 'USAGE#2026-10-15',
    });
    expect(await getItem(jobPk(jobId), JOB_SK)).toMatchObject({
      userId: session.sub,
      type: 'generate',
      status: 'queued',
      modelId: 'mock',
      provider: 'mock',
      pointsReserved: 6,
      usageDate: '2026-10-15',
      attempts: 0,
      request: generate({ quality: 'high', count: 2 }),
      GSI1PK: 'JOBS#queued',
      GSI1SK: '2026-10-15T12:00:00.000Z',
    });
  });

  it('reserves up to the daily limit exactly, then answers 402 with what is left', async () => {
    const session = await onboardedSession();
    const d = deps({ defaultDailyPoints: 5 });
    expect((await createJob(d, session, generate({ quality: 'high' }))).status).toBe(202);
    await finishJobs(session.sub);
    expect((await createJob(d, session, generate({ quality: 'standard' }))).status).toBe(202);
    await finishJobs(session.sub);
    const refused = await createJob(d, session, generate());
    expect(refused).toMatchObject({ status: 402, body: { code: 'out_of_points' } });
    expect(refused.body.error).toBe(
      'This request needs 1 point and you have 0 left today. Points reset at 00:00 UTC.',
    );
    expect(await usedToday(session.sub)).toBe(5);
    expect((await profileOf(session.sub))?.activeJobs).toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('answers 402 for a request bigger than the whole allowance, even on a fresh day', async () => {
    const session = await onboardedSession();
    const result = await createJob(
      deps({ defaultDailyPoints: 10 }),
      session,
      generate({ quality: 'high', count: 4 }),
    );
    expect(result).toMatchObject({ status: 402, body: { code: 'out_of_points' } });
    expect(result.body.error).toMatch(/needs 12 points and you have 10 left/);
    expect(await usedToday(session.sub)).toBeUndefined();
  });

  it('lets exactly one of two concurrent requests through when together they exceed the limit', async () => {
    const session = await onboardedSession();
    await createJob(deps(), session, generate({ quality: 'draft' })); // creates the profile
    await finishJobs(session.sub);
    await setProfile(session.sub, { dailyPoints: 21 });
    const request = generate({ quality: 'high', count: 4 }); // 12 points each; 1 already used
    const results = await Promise.all([
      createJob(deps(), session, request),
      createJob(deps(), session, request),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 402]);
    expect(await usedToday(session.sub)).toBe(13);
    expect((await profileOf(session.sub))?.activeJobs).toBe(1);
  });

  it('allows 10 jobs a minute, then answers 429 until the next minute', async () => {
    const session = await onboardedSession();
    const d = deps({ defaultDailyPoints: 100 });
    for (let i = 0; i < 10; i++) {
      expect((await createJob(d, session, generate())).status).toBe(202);
      await finishJobs(session.sub);
    }
    const limited = await createJob(d, session, generate());
    expect(limited).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    expect(await usedToday(session.sub)).toBe(10);
    expect(await getItem(userPk(session.sub), 'RATE#202610151200')).toMatchObject({ count: 10 });

    clock = new Date('2026-10-15T12:01:00Z');
    expect((await createJob(d, session, generate())).status).toBe(202);
  });

  it('allows 2 running jobs, then answers 429 until one finishes', async () => {
    const session = await onboardedSession();
    expect((await createJob(deps(), session, generate())).status).toBe(202);
    expect((await createJob(deps(), session, generate())).status).toBe(202);
    const third = await createJob(deps(), session, generate());
    expect(third).toMatchObject({ status: 429, body: { code: 'too_many_jobs' } });
    expect(await usedToday(session.sub)).toBe(2);
    await setProfile(session.sub, { activeJobs: 1 });
    expect((await createJob(deps(), session, generate())).status).toBe(202);
  });

  it('answers 403 to a suspended user and reserves nothing', async () => {
    const session = await onboardedSession();
    await getMe(deps(), session);
    await setProfile(session.sub, { status: 'suspended' });
    const result = await createJob(deps(), session, generate());
    expect(result).toMatchObject({ status: 403, body: { code: 'suspended' } });
    expect(await usedToday(session.sub)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers 403 during a cooldown, and accepts jobs once it ends', async () => {
    const session = await onboardedSession();
    await getMe(deps(), session);
    await setProfile(session.sub, { cooldownUntil: '2026-10-15T12:30:00.000Z' });
    const result = await createJob(deps(), session, generate());
    expect(result).toMatchObject({ status: 403, body: { code: 'cooldown' } });
    expect(result.body.error).toBe(
      'Image creation is paused for your account until 15 October at 12:30 UTC after several blocked requests.',
    );
    clock = new Date('2026-10-15T12:30:00Z');
    expect((await createJob(deps(), session, generate())).status).toBe(202);
  });

  it('refuses in the transaction when the profile is suspended after the first read', async () => {
    const session = await onboardedSession();
    await getMe(deps(), session);
    // Suspend the user between the profile read and the reservation.
    const d = deps();
    const original = d.client.send.bind(d.client);
    let suspended = false;
    const spy = vi.spyOn(d.client, 'send').mockImplementation(async (command: unknown) => {
      if (!suspended && command?.constructor?.name === 'TransactWriteCommand') {
        suspended = true;
        await setProfile(session.sub, { status: 'suspended' });
      }
      return original(command as never);
    });
    try {
      const result = await createJob(d, session, generate());
      expect(result).toMatchObject({ status: 403, body: { code: 'suspended' } });
      expect(await usedToday(session.sub)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses jobs until the user has been through onboarding', async () => {
    const session = newSession();
    const result = await createJob(deps(), session, generate());
    expect(result).toMatchObject({ status: 403, body: { code: 'onboarding_required' } });
    expect(result.body.error).toMatch(/accept the terms before creating your first image/);
    expect(await usedToday(session.sub)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();

    await setProfile(session.sub, ONBOARDED);
    expect((await createJob(deps(), session, generate())).status).toBe(202);
  });

  it('refuses jobs from a user who has only confirmed part of onboarding', async () => {
    const session = newSession();
    await setProfile(session.sub, { ...ONBOARDED, ageConfirmed: false });
    expect(await createJob(deps(), session, generate())).toMatchObject({
      status: 403,
      body: { code: 'onboarding_required' },
    });
  });

  it('sends users through acceptance again when the terms version changes', async () => {
    const session = newSession();
    await setProfile(session.sub, { ...ONBOARDED, tosVersion: '2020-01-01' });
    const result = await createJob(deps(), session, generate());
    expect(result).toMatchObject({ status: 403, body: { code: 'onboarding_required' } });
    expect(result.body.error).toMatch(/terms have changed/);
    expect((await getMe(deps(), session)).body).toMatchObject({ onboardingRequired: true });
  });

  it('refuses jobs from an account that is being deleted', async () => {
    const session = await onboardedSession();
    await setProfile(session.sub, { status: 'deleting' });
    expect(await createJob(deps(), session, generate())).toMatchObject({
      status: 403,
      body: { code: 'account_deleting' },
    });
    expect(await usedToday(session.sub)).toBeUndefined();
  });

  it('fails the job and refunds the points and the slot when the queue send fails', async () => {
    const session = await onboardedSession();
    enqueue.mockRejectedValueOnce(new Error('SQS unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await createJob(deps(), session, generate({ quality: 'high' }));
    expect(result).toEqual({
      status: 503,
      body: { code: 'enqueue_failed', error: JOB_ERROR_MESSAGES.enqueue_failed },
    });
    expect(await usedToday(session.sub)).toBe(0);
    expect((await profileOf(session.sub))?.activeJobs).toBe(0);
    const jobId = enqueue.mock.calls[0]?.[1] as string;
    expect(await getItem(jobPk(jobId), JOB_SK)).toMatchObject({
      status: 'failed',
      pointsCharged: 0,
      error: { code: 'enqueue_failed', message: JOB_ERROR_MESSAGES.enqueue_failed },
      finishedAt: '2026-10-15T12:00:00.000Z',
    });
    // Off the active-jobs index, so the sweeper leaves it alone.
    const failed = await getItem(jobPk(jobId), JOB_SK);
    expect(failed).not.toHaveProperty('GSI1PK');
    expect(failed).not.toHaveProperty('GSI1SK');
    vi.mocked(console.error).mockRestore();
  });

  it('uses dailyPoints from the profile from the next request on, and the default once it is removed', async () => {
    const session = await onboardedSession();
    const d = deps({ defaultDailyPoints: 3 });
    expect((await createJob(d, session, generate({ quality: 'high' }))).status).toBe(202);
    await finishJobs(session.sub);
    expect((await createJob(d, session, generate())).status).toBe(402);

    await setProfile(session.sub, { dailyPoints: 50 });
    expect((await createJob(d, session, generate({ quality: 'high', count: 4 }))).status).toBe(202);
    expect((await getMe(d, session)).body).toMatchObject({ dailyLimit: 50, pointsUsed: 15 });

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(session.sub), SK: PROFILE_SK },
        UpdateExpression: 'REMOVE dailyPoints',
      }),
    );
    await finishJobs(session.sub);
    expect((await createJob(d, session, generate())).status).toBe(402);
  });

  describe('getJobStatus', () => {
    const owner = newSession();
    const other = newSession();
    const putJob = async (fields: Partial<JobItem>) => {
      idCounter += 1;
      const jobId = `01K${String(idCounter).padStart(23, '0')}`;
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: jobPk(jobId),
            SK: JOB_SK,
            jobId,
            userId: owner.sub,
            type: 'generate',
            status: 'queued',
            request: generate(),
            modelId: 'mock',
            provider: 'mock',
            pointsReserved: 2,
            usageDate: '2026-10-15',
            createdAt: '2026-10-15T12:00:00.000Z',
            attempts: 0,
            ttl: 0,
            ...fields,
          } satisfies JobItem,
        }),
      );
      return jobId;
    };

    it('reports a queued job to its owner', async () => {
      const jobId = await putJob({});
      expect(await getJobStatus(deps(), owner, jobId)).toEqual({
        status: 200,
        body: {
          jobId,
          type: 'generate',
          status: 'queued',
          modelId: 'mock',
          createdAt: '2026-10-15T12:00:00.000Z',
          pointsReserved: 2,
        },
      });
    });

    it("answers 404 to anyone but the owner, as for a job that doesn't exist", async () => {
      const jobId = await putJob({});
      const notFound = { status: 404, body: { code: 'not_found', error: 'Job not found.' } };
      expect(await getJobStatus(deps(), other, jobId)).toEqual(notFound);
      expect(await getJobStatus(deps(), owner, '01J99999999999999999999999')).toEqual(notFound);
      expect(await getJobStatus(deps(), owner, 'not-a-job-id')).toEqual(notFound);
    });

    it('returns the images with presigned URLs once the job succeeded', async () => {
      const jobId = await putJob({
        status: 'succeeded',
        pointsCharged: 2,
        finishedAt: '2026-10-15T12:00:10.000Z',
        images: [
          { imageId: 'IMG1', version: 1, s3Key: `users/${owner.sub}/IMG1/v1.png` },
          { imageId: 'IMG2', version: 1, s3Key: `users/${owner.sub}/IMG2/v1.png` },
        ],
      });
      const result = await getJobStatus(deps(), owner, jobId);
      expect(result.body).toMatchObject({
        status: 'succeeded',
        pointsCharged: 2,
        finishedAt: '2026-10-15T12:00:10.000Z',
        images: [
          {
            imageId: 'IMG1',
            version: 1,
            url: `https://signed.example/users/${owner.sub}/IMG1/v1.png`,
            downloadUrl: `https://signed.example/users/${owner.sub}/IMG1/v1.png?download=pictora-IMG1-v1.png`,
          },
          {
            imageId: 'IMG2',
            version: 1,
            url: `https://signed.example/users/${owner.sub}/IMG2/v1.png`,
            downloadUrl: `https://signed.example/users/${owner.sub}/IMG2/v1.png?download=pictora-IMG2-v1.png`,
          },
        ],
      });
    });

    it("never presigns a key outside the owner's prefix", async () => {
      const jobId = await putJob({
        status: 'succeeded',
        images: [{ imageId: 'IMG3', version: 1, s3Key: `users/${other.sub}/IMG3/v1.png` }],
      });
      expect((await getJobStatus(deps(), owner, jobId)).body.images).toEqual([]);
    });

    it('returns the plain-language error of a failed or blocked job', async () => {
      const failed = await putJob({
        status: 'failed',
        error: { code: 'timeout', message: JOB_ERROR_MESSAGES.timeout },
      });
      expect((await getJobStatus(deps(), owner, failed)).body).toMatchObject({
        status: 'failed',
        error: JOB_ERROR_MESSAGES.timeout,
      });
      const blocked = await putJob({
        status: 'blocked',
        error: { code: 'blocked', message: JOB_ERROR_MESSAGES.blocked },
      });
      expect((await getJobStatus(deps(), owner, blocked)).body).toMatchObject({
        status: 'blocked',
        error: JOB_ERROR_MESSAGES.blocked,
      });
    });
  });

  describe('getMe', () => {
    it('creates the profile on first use and reports a full allowance', async () => {
      const session = await onboardedSession();
      expect(await getMe(deps(), session)).toEqual({
        status: 200,
        body: {
          sub: session.sub,
          email: 'user@example.com',
          status: 'active',
          date: '2026-10-15',
          dailyLimit: 25,
          pointsUsed: 0,
          pointsLeft: 25,
          activeJobs: 0,
          onboardingRequired: false,
          memberSince: '2026-10-15T12:00:00.000Z',
        },
      });
      expect(await profileOf(session.sub)).toMatchObject({
        email: 'user@example.com',
        createdAt: '2026-10-15T12:00:00.000Z',
      });
    });

    it('reports points used and left today, the limit and running jobs', async () => {
      const session = await onboardedSession();
      await createJob(deps(), session, generate({ quality: 'high', count: 3 }));
      await createJob(deps(), session, generate({ quality: 'standard' }));
      expect((await getMe(deps(), session)).body).toMatchObject({
        dailyLimit: 25,
        pointsUsed: 11,
        pointsLeft: 14,
        activeJobs: 2,
      });
    });

    it('never reports fewer than 0 points left, and starts a new day at 0 used', async () => {
      const session = await onboardedSession();
      await getMe(deps(), session);
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: { PK: userPk(session.sub), SK: usageSk('2026-10-15'), used: 30 },
        }),
      );
      expect((await getMe(deps(), session)).body).toMatchObject({ pointsUsed: 30, pointsLeft: 0 });
      clock = new Date('2026-10-16T00:00:00Z');
      expect((await getMe(deps(), session)).body).toMatchObject({
        date: '2026-10-16',
        pointsUsed: 0,
        pointsLeft: 25,
      });
    });

    it('keeps createdAt on later calls and follows a changed email', async () => {
      const session = await onboardedSession();
      await getMe(deps(), session);
      clock = new Date('2026-10-15T13:00:00Z');
      await getMe(deps(), { ...session, email: 'new@example.com' });
      expect(await profileOf(session.sub)).toMatchObject({
        email: 'new@example.com',
        createdAt: '2026-10-15T12:00:00.000Z',
      });
    });
  });
});
