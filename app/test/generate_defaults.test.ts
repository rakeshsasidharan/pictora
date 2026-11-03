import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  APP_GENERATE_DEFAULTS,
  DEFAULTS_SK,
  PROFILE_SK,
  userPk,
  type GenerateDefaults,
} from '@pictora/core';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELETE, GET, PUT } from '../src/app/api/me/defaults/route';
import {
  defaultsFromItem,
  getDefaults,
  readGenerateDefaults,
  resetDefaults,
  saveDefaults,
  type DefaultsDeps,
} from '../src/lib/generate_defaults';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const SAVED: GenerateDefaults = {
  style: 'watercolour',
  modelId: 'gpt-image-2',
  aspect: '16:9',
  quality: 'high',
  count: 3,
  transparentBackground: true,
  deliverLater: false,
  avoid: '',
  enhance: false,
};

let counter = 0;
function newSession(): Session {
  counter += 1;
  return { sub: `defaults-${counter}-${Date.now()}`, email: 'user@example.com', groups: [] };
}

describe('defaults routes', () => {
  it('answer 401 without a session', async () => {
    const url = 'https://pictora.example.dev/api/me/defaults';
    expect((await GET(new NextRequest(url))).status).toBe(401);
    expect(
      (await PUT(new NextRequest(url, { method: 'PUT', body: JSON.stringify(SAVED) }))).status,
    ).toBe(401);
    expect((await DELETE(new NextRequest(url, { method: 'DELETE' }))).status).toBe(401);
  });
});

describe('defaultsFromItem', () => {
  it('gives the app defaults when nothing is saved', () => {
    expect(defaultsFromItem(undefined)).toEqual(APP_GENERATE_DEFAULTS);
  });

  it('keeps every valid field and replaces only the stale ones', () => {
    expect(
      defaultsFromItem({
        PK: 'USER#x',
        SK: DEFAULTS_SK,
        ...SAVED,
        style: 'retired-style',
        count: 9,
        updatedAt: '2026-11-01T00:00:00.000Z',
      }),
    ).toEqual({ ...SAVED, style: APP_GENERATE_DEFAULTS.style, count: APP_GENERATE_DEFAULTS.count });
  });
});

describe('saveDefaults: request checks', () => {
  const offline: DefaultsDeps = {
    client: { send: () => Promise.reject(new Error('no DynamoDB')) } as never,
    tableName: 'unused',
    now: () => new Date('2026-11-01T12:00:00Z'),
  };

  it.each([
    ['nothing', null],
    ['a partial body', { style: 'anime' }],
    ['an unknown field', { ...SAVED, isAdmin: true }],
    ['an invalid count', { ...SAVED, count: 0 }],
  ])('refuses %s before touching DynamoDB', async (_case, input) => {
    expect(await saveDefaults(offline, newSession(), input)).toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('defaults API against DynamoDB Local', () => {
  const table = localTable('pictora-defaults');
  const { client, tableName } = table;
  const deps: DefaultsDeps = {
    client,
    tableName,
    now: () => new Date('2026-11-01T12:00:00Z'),
  };
  const itemOf = async (sub: string) =>
    (
      await client.send(
        new GetCommand({ TableName: tableName, Key: { PK: userPk(sub), SK: DEFAULTS_SK } }),
      )
    ).Item;
  const markDeleting = (sub: string) =>
    client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: PROFILE_SK },
        UpdateExpression: 'SET #s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'deleting' },
      }),
    );

  beforeAll(() => table.create());
  afterAll(() => table.drop());

  it('answers the app defaults until the user saves their own', async () => {
    const session = newSession();
    expect(await getDefaults(deps, session)).toEqual({
      status: 200,
      body: { defaults: APP_GENERATE_DEFAULTS, saved: false },
    });
    expect(await readGenerateDefaults(client, tableName, session.sub)).toEqual(
      APP_GENERATE_DEFAULTS,
    );
  });

  it('saves every option under the user, and reads them back', async () => {
    const session = newSession();
    expect(await saveDefaults(deps, session, { ...SAVED, avoid: '  blur ' })).toEqual({
      status: 200,
      body: {
        defaults: { ...SAVED, avoid: 'blur' },
        saved: true,
        updatedAt: '2026-11-01T12:00:00.000Z',
      },
    });
    expect(await itemOf(session.sub)).toEqual({
      PK: userPk(session.sub),
      SK: DEFAULTS_SK,
      ...SAVED,
      avoid: 'blur',
      updatedAt: '2026-11-01T12:00:00.000Z',
    });
    expect(await readGenerateDefaults(client, tableName, session.sub)).toEqual({
      ...SAVED,
      avoid: 'blur',
    });
    expect((await getDefaults(deps, session)).body).toMatchObject({ saved: true });
    // Another user still has the app defaults.
    expect(await readGenerateDefaults(client, tableName, newSession().sub)).toEqual(
      APP_GENERATE_DEFAULTS,
    );
  });

  it('replaces earlier defaults', async () => {
    const session = newSession();
    await saveDefaults(deps, session, SAVED);
    await saveDefaults(deps, session, { ...SAVED, style: 'anime', count: 1 });
    expect(await readGenerateDefaults(client, tableName, session.sub)).toMatchObject({
      style: 'anime',
      count: 1,
      quality: 'high',
    });
  });

  it('resets to the app defaults by removing the item', async () => {
    const session = newSession();
    await saveDefaults(deps, session, SAVED);
    expect(await resetDefaults(deps, session)).toEqual({
      status: 200,
      body: { defaults: APP_GENERATE_DEFAULTS, saved: false },
    });
    expect(await itemOf(session.sub)).toBeUndefined();
    // Resetting again is harmless.
    expect((await resetDefaults(deps, session)).status).toBe(200);
  });

  it('refuses to save or reset for an account being deleted', async () => {
    const session = newSession();
    await saveDefaults(deps, session, SAVED);
    await markDeleting(session.sub);
    expect(await saveDefaults(deps, session, { ...SAVED, style: 'anime' })).toMatchObject({
      status: 403,
      body: { code: 'account_deleting' },
    });
    expect(await resetDefaults(deps, session)).toMatchObject({
      status: 403,
      body: { code: 'account_deleting' },
    });
    expect(await itemOf(session.sub)).toMatchObject({ style: 'watercolour' });
  });

  it('reads stored defaults field by field, so a stale value keeps the rest', async () => {
    const session = newSession();
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: { PK: userPk(session.sub), SK: DEFAULTS_SK, ...SAVED, aspect: '5:4' },
      }),
    );
    expect(await readGenerateDefaults(client, tableName, session.sub)).toEqual({
      ...SAVED,
      aspect: APP_GENERATE_DEFAULTS.aspect,
    });
  });
});
