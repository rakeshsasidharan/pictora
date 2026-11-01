import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { BETA_ALLOWLIST_PK, loadSeedRegistry } from '@pictora/core';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdminDeps } from '../src/lib/admin_stats';
import {
  addBetaEmail,
  betaMode,
  listBetaAllowlist,
  removeBetaEmail,
  type BetaAllowlistBody,
} from '../src/lib/beta';
import type { Session } from '../src/lib/session';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const NOW = new Date('2026-10-31T09:00:00Z');
const admin: Session = { sub: 'admin-sub', email: 'admin@example.com', groups: ['admins'] };
const someone: Session = { sub: 'someone', email: 'someone@example.com', groups: [] };

/** Deps that fail on any table call, for checks that answer first. */
const offline: AdminDeps = {
  client: { send: () => Promise.reject(new Error('no table')) } as unknown as AdminDeps['client'],
  tableName: 'unused',
  models: async () => modelsAvailableIn(loadSeedRegistry(), 'dev'),
  presign: async (key) => key,
  spendCapCents: 2000,
  defaultDailyPoints: 25,
  now: () => NOW,
  newId: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ',
};

describe('betaMode', () => {
  it('is on only when BETA_MODE is true', () => {
    expect(betaMode({ BETA_MODE: 'true' })).toBe(true);
    expect(betaMode({ BETA_MODE: 'false' })).toBe(false);
    expect(betaMode({})).toBe(false);
  });
});

describe('beta allowlist APIs refuse non-admins and bad input', () => {
  it('answers 403 to anyone but admins, before reading anything', async () => {
    const forbidden = { status: 403, body: { code: 'forbidden' } };
    await expect(listBetaAllowlist(offline, someone)).resolves.toMatchObject(forbidden);
    await expect(addBetaEmail(offline, someone, { email: 'a@example.com' })).resolves.toMatchObject(
      forbidden,
    );
    await expect(removeBetaEmail(offline, someone, 'a@example.com')).resolves.toMatchObject(
      forbidden,
    );
  });

  it.each([
    ['no email', {}],
    ['not an email', { email: 'not-an-email' }],
    ['too long', { email: `${'a'.repeat(250)}@example.com` }],
    ['a number', { email: 42 }],
    ['an unknown field', { email: 'a@example.com', note: 'friend' }],
    ['not an object', 'a@example.com'],
  ])('rejects adding %s with 400', async (_name, input) => {
    await expect(addBetaEmail(offline, admin, input)).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid_request', error: /valid email address/ },
    });
  });

  it('rejects removing something that is not an email', async () => {
    await expect(removeBetaEmail(offline, admin, 'x')).resolves.toMatchObject({ status: 400 });
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('beta allowlist APIs against DynamoDB Local', () => {
  const table = localTable('pictora-beta');
  const { client, tableName } = table;
  const deps: AdminDeps = { ...offline, client, tableName };

  beforeAll(() => table.create());
  afterAll(() => table.drop());

  it('adds emails in lower case, lists them, and removes them', async () => {
    vi.stubEnv('BETA_MODE', 'true');
    await expect(listBetaAllowlist(deps, admin)).resolves.toEqual({
      status: 200,
      body: { betaMode: true, entries: [] },
    });

    await expect(addBetaEmail(deps, admin, { email: ' Invited@Example.COM ' })).resolves.toEqual({
      status: 200,
      body: { email: 'invited@example.com', addedAt: NOW.toISOString(), addedBy: 'admin-sub' },
    });
    const stored = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: BETA_ALLOWLIST_PK, SK: 'invited@example.com' },
      }),
    );
    expect(stored.Item).toMatchObject({ email: 'invited@example.com', addedBy: 'admin-sub' });

    // Adding it again keeps the first entry.
    const again = await addBetaEmail(
      { ...deps, now: () => new Date('2026-11-01T00:00:00Z') },
      { ...admin, sub: 'other-admin' },
      { email: 'invited@example.com' },
    );
    expect(again.body).toMatchObject({ addedAt: NOW.toISOString(), addedBy: 'admin-sub' });

    await addBetaEmail(deps, admin, { email: 'another@example.com' });
    const listed = await listBetaAllowlist(deps, admin);
    expect((listed.body as unknown as BetaAllowlistBody).entries.map((e) => e.email)).toEqual([
      'another@example.com',
      'invited@example.com',
    ]);

    // The path parameter may arrive percent-encoded, and in any case.
    await expect(removeBetaEmail(deps, admin, 'Invited%40example.com')).resolves.toEqual({
      status: 200,
      body: { email: 'invited@example.com', removed: true },
    });
    await expect(removeBetaEmail(deps, admin, 'invited@example.com')).resolves.toMatchObject({
      status: 404,
    });
    vi.stubEnv('BETA_MODE', 'false');
    await expect(listBetaAllowlist(deps, admin)).resolves.toMatchObject({
      body: { betaMode: false, entries: [{ email: 'another@example.com' }] },
    });
    vi.unstubAllEnvs();
  });
});
