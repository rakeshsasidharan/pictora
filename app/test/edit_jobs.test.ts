import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  JOB_SK,
  PROFILE_SK,
  TESTERS_GROUP,
  TOS_VERSION,
  imageKey,
  imageSk,
  jobPk,
  loadSeedRegistry,
  uploadKey,
  usageSk,
  userPk,
  versionSk,
  type EditJobRequest,
  type ModelConfig,
} from '@pictora/core';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJob, unsupportedEditOption, type JobsDeps } from '../src/lib/jobs';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const devModels = modelsAvailableIn(loadSeedRegistry(), 'dev');
const model = (id: string): ModelConfig => {
  const found = devModels.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} in the dev registry`);
  return found;
};

const IMAGE_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

/** An edit of version 1 with the mock model at draft quality, which costs 1 point. */
function edit(overrides: Partial<EditJobRequest> = {}): EditJobRequest {
  return {
    type: 'edit',
    imageId: IMAGE_ID,
    parentVersion: 1,
    instruction: 'Make it night',
    modelId: 'mock',
    quality: 'draft',
    ...overrides,
  };
}

describe('unsupportedEditOption', () => {
  it('accepts an edit the model can make', () => {
    expect(
      unsupportedEditOption(model('gemini-3.1-flash-image'), edit({ quality: 'standard' })),
    ).toBeUndefined();
  });

  it('names a model that cannot edit, a missing quality and too many references', () => {
    expect(unsupportedEditOption(model('stable-image-core'), edit())).toMatch(
      /Stable Image Core can't edit images/,
    );
    expect(unsupportedEditOption(model('gpt-image-1-mini'), edit({ quality: 'high' }))).toMatch(
      /doesn't offer high quality/,
    );
    const key = uploadKey('sub', IMAGE_ID);
    const mock = model('mock');
    const one = { ...mock, capabilities: { ...mock.capabilities, referenceImages: 1 } };
    const none = { ...mock, capabilities: { ...mock.capabilities, referenceImages: 0 } };
    expect(unsupportedEditOption(one, edit({ referenceKeys: [key, key] }))).toMatch(
      /takes up to 1 reference image\./,
    );
    expect(unsupportedEditOption(none, edit({ referenceKeys: [key] }))).toMatch(
      /doesn't take reference images/,
    );
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('edit jobs against DynamoDB Local', () => {
  const table = localTable('pictora-edit-jobs');
  const { client, tableName } = table;
  let sessions = 0;
  let ids = 0;
  let enqueue: ReturnType<typeof vi.fn<JobsDeps['enqueue']>>;
  /** Uploads in the mocked bucket, by key, with their sizes. */
  let uploads: Map<string, number>;

  const deps = (overrides: Partial<JobsDeps> = {}): JobsDeps => ({
    client,
    tableName,
    models: async () => devModels,
    hasQueue: () => true,
    enqueue,
    presign: async (key) => `https://signed.example/${key}`,
    objectSize: async (key) => uploads.get(key),
    defaultDailyPoints: 25,
    spendCapCents: 2000,
    now: () => new Date('2026-10-15T12:00:00Z'),
    newJobId: () => `01J${String(++ids).padStart(23, '0')}`,
    ...overrides,
  });

  const getItem = async (PK: string, SK: string) =>
    (await client.send(new GetCommand({ TableName: tableName, Key: { PK, SK } }))).Item;
  const put = (item: Record<string, unknown>) =>
    client.send(new PutCommand({ TableName: tableName, Item: item }));

  /** An onboarded user with version 1 of `IMAGE_ID` (and version 2 when asked), 1600×900 with no aspect. */
  async function userWithImage(options: { versions?: number } = {}): Promise<Session> {
    sessions += 1;
    const session: Session = {
      sub: `edit-user-${sessions}-${Date.now()}`,
      email: 'user@example.com',
      // A tester, since these edits use the Mock model.
      groups: [TESTERS_GROUP],
    };
    await put({
      PK: userPk(session.sub),
      SK: PROFILE_SK,
      email: session.email,
      createdAt: '2026-10-14T09:00:00.000Z',
      status: 'active',
      activeJobs: 0,
      tosAcceptedAt: '2026-10-14T09:00:00.000Z',
      tosVersion: TOS_VERSION,
      ageConfirmed: true,
    });
    await put({
      PK: userPk(session.sub),
      SK: imageSk(IMAGE_ID),
      imageId: IMAGE_ID,
      latestVersion: 1,
    });
    for (let version = 1; version <= (options.versions ?? 1); version++) {
      await put({
        PK: userPk(session.sub),
        SK: versionSk(IMAGE_ID, version),
        imageId: IMAGE_ID,
        version,
        s3Key: imageKey(session.sub, IMAGE_ID, version),
        width: 1600,
        height: 900,
      });
    }
    return session;
  }

  beforeAll(() => table.create());
  afterAll(() => table.drop());
  beforeEach(() => {
    enqueue = vi.fn<JobsDeps['enqueue']>(async () => undefined);
    uploads = new Map();
  });

  it('reserves one image at the quality and queues the edit job', async () => {
    const session = await userWithImage();
    const request = edit({ quality: 'high' });
    const result = await createJob(deps(), session, request);
    expect(result.status).toBe(202);
    const { jobId } = result.body as { jobId: string };
    expect(result.body).toEqual({ jobId, status: 'queued', pointsReserved: 3, modelId: 'mock' });
    expect(enqueue).toHaveBeenCalledWith('mock', jobId);
    expect(await getItem(jobPk(jobId), JOB_SK)).toMatchObject({
      type: 'edit',
      status: 'queued',
      modelId: 'mock',
      pointsReserved: 3,
      request,
    });
    expect((await getItem(userPk(session.sub), usageSk('2026-10-15')))?.used).toBe(3);
    expect((await getItem(userPk(session.sub), PROFILE_SK))?.activeJobs).toBe(1);
  });

  it('accepts an edit of an earlier version with references of the user', async () => {
    const session = await userWithImage({ versions: 3 });
    const upload = uploadKey(session.sub, '01JBBBBBBBBBBBBBBBBBBBBBBB');
    uploads.set(upload, 2_000_000);
    const result = await createJob(
      deps(),
      session,
      edit({ parentVersion: 1, referenceKeys: [upload, imageKey(session.sub, IMAGE_ID, 3)] }),
    );
    expect(result.status).toBe(202);
  });

  it("answers 404 for another user's image, a missing version, and someone else's reference", async () => {
    const owner = await userWithImage();
    const other = await userWithImage();
    const notFound = { status: 404, body: { code: 'not_found' } };

    await expect(
      createJob(deps(), other, edit({ imageId: '01JCCCCCCCCCCCCCCCCCCCCCCC' })),
    ).resolves.toMatchObject(notFound);
    await expect(createJob(deps(), other, edit({ parentVersion: 2 }))).resolves.toMatchObject(
      notFound,
    );
    // The other user owns an image with the same ID, but references must be their own too.
    await expect(
      createJob(deps(), other, edit({ referenceKeys: [imageKey(owner.sub, IMAGE_ID, 1)] })),
    ).resolves.toMatchObject(notFound);
    const theirUpload = uploadKey(owner.sub, '01JBBBBBBBBBBBBBBBBBBBBBBB');
    uploads.set(theirUpload, 100);
    await expect(
      createJob(deps(), other, edit({ referenceKeys: [theirUpload] })),
    ).resolves.toMatchObject(notFound);

    expect(enqueue).not.toHaveBeenCalled();
    expect(await getItem(userPk(other.sub), usageSk('2026-10-15'))).toBeUndefined();
  });

  it('answers 404 for a reference upload that expired or is over 10 MB', async () => {
    const session = await userWithImage();
    const missing = uploadKey(session.sub, '01JBBBBBBBBBBBBBBBBBBBBBBB');
    const huge = uploadKey(session.sub, '01JDDDDDDDDDDDDDDDDDDDDDDD');
    uploads.set(huge, 10 * 1024 * 1024 + 1);
    for (const key of [missing, huge]) {
      await expect(
        createJob(deps(), session, edit({ referenceKeys: [key] })),
      ).resolves.toMatchObject({ status: 404 });
    }
  });

  it('refuses a model that cannot edit before reading the image', async () => {
    const session = await userWithImage();
    const result = await createJob(deps(), session, edit({ modelId: 'stable-image-core' }));
    expect(result).toMatchObject({ status: 400, body: { code: 'unsupported_option' } });
  });

  it('answers 402 when the edit costs more than the points left', async () => {
    const session = await userWithImage();
    const result = await createJob(
      deps({ defaultDailyPoints: 2 }),
      session,
      edit({ quality: 'high' }),
    );
    expect(result).toMatchObject({ status: 402, body: { code: 'out_of_points' } });
  });
});
