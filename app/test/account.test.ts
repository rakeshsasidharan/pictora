import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROFILE_SK, TOS_VERSION, userPk, type PurgeMessage } from '@pictora/core';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeOnboarding, deleteAccount, type AccountDeps } from '../src/lib/account';
import type { Session } from '../src/lib/session';
import { DELETE } from '../src/app/api/me/route';
import { POST as onboardingPost } from '../src/app/api/me/onboarding/route';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

const ACCEPT = { ageConfirmed: true, termsAccepted: true, tosVersion: TOS_VERSION };

let counter = 0;
function newSession(username?: string): Session {
  counter += 1;
  const sub = `account-${counter}-${Date.now()}`;
  return { sub, email: 'user@example.com', groups: [], username: username ?? sub };
}

describe('account routes', () => {
  it('answer 401 without a session', async () => {
    const del = await DELETE(
      new NextRequest('https://pictora.example.dev/api/me', { method: 'DELETE' }),
    );
    expect(del.status).toBe(401);
    const post = await onboardingPost(
      new NextRequest('https://pictora.example.dev/api/me/onboarding', {
        method: 'POST',
        body: JSON.stringify(ACCEPT),
      }),
    );
    expect(post.status).toBe(401);
  });
});

describe('completeOnboarding: request checks', () => {
  const offline: AccountDeps = {
    client: { send: () => Promise.reject(new Error('no DynamoDB')) } as never,
    tableName: 'unused',
    disableUser: async () => undefined,
    signOutUser: async () => undefined,
    requestPurge: async () => undefined,
    now: () => new Date('2026-10-15T12:00:00Z'),
  };

  it('needs both confirmations', async () => {
    for (const input of [
      { ...ACCEPT, ageConfirmed: false },
      { ...ACCEPT, termsAccepted: false },
      {},
      null,
    ]) {
      expect(await completeOnboarding(offline, newSession(), input)).toMatchObject({
        status: 400,
        body: { code: 'invalid_request' },
      });
    }
  });

  it('refuses acceptance of an older terms version', async () => {
    expect(
      await completeOnboarding(offline, newSession(), { ...ACCEPT, tosVersion: '2020-01-01' }),
    ).toMatchObject({ status: 409, body: { code: 'terms_changed' } });
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('account API against DynamoDB Local', () => {
  const table = localTable('pictora-account');
  const { client, tableName } = table;
  let purges: PurgeMessage[];
  let disableUser: ReturnType<typeof vi.fn<AccountDeps['disableUser']>>;
  let signOutUser: ReturnType<typeof vi.fn<AccountDeps['signOutUser']>>;
  let requestPurge: ReturnType<typeof vi.fn<AccountDeps['requestPurge']>>;

  const deps = (overrides: Partial<AccountDeps> = {}): AccountDeps => ({
    client,
    tableName,
    disableUser,
    signOutUser,
    requestPurge,
    now: () => new Date('2026-10-15T12:00:00Z'),
    ...overrides,
  });
  const profileOf = async (sub: string) =>
    (
      await client.send(
        new GetCommand({ TableName: tableName, Key: { PK: userPk(sub), SK: PROFILE_SK } }),
      )
    ).Item;
  const setStatus = (sub: string, status: string) =>
    client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: PROFILE_SK },
        UpdateExpression: 'SET #s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
      }),
    );

  beforeAll(() => table.create());
  afterAll(() => table.drop());
  beforeEach(() => {
    purges = [];
    disableUser = vi.fn(async () => undefined);
    signOutUser = vi.fn(async () => undefined);
    requestPurge = vi.fn(async (message: PurgeMessage) => {
      purges.push(message);
    });
  });

  describe('completeOnboarding', () => {
    it('records the age confirmation and the accepted terms version', async () => {
      const session = newSession();
      expect(await completeOnboarding(deps(), session, ACCEPT)).toEqual({
        status: 200,
        body: {
          tosAcceptedAt: '2026-10-15T12:00:00.000Z',
          tosVersion: TOS_VERSION,
          ageConfirmed: true,
        },
      });
      expect(await profileOf(session.sub)).toMatchObject({
        email: 'user@example.com',
        status: 'active',
        tosAcceptedAt: '2026-10-15T12:00:00.000Z',
        tosVersion: TOS_VERSION,
        ageConfirmed: true,
      });
    });

    it('records a new version when the terms change', async () => {
      const session = newSession();
      await completeOnboarding(deps({ tosVersion: '2026-01-01' }), session, {
        ...ACCEPT,
        tosVersion: '2026-01-01',
      });
      await completeOnboarding(
        deps({ now: () => new Date('2026-11-01T08:00:00Z') }),
        session,
        ACCEPT,
      );
      expect(await profileOf(session.sub)).toMatchObject({
        tosVersion: TOS_VERSION,
        tosAcceptedAt: '2026-11-01T08:00:00.000Z',
      });
    });

    it('refuses an account that is being deleted', async () => {
      const session = newSession();
      await completeOnboarding(deps(), session, ACCEPT);
      await setStatus(session.sub, 'deleting');
      expect(await completeOnboarding(deps(), session, ACCEPT)).toMatchObject({
        status: 403,
        body: { code: 'account_deleting' },
      });
    });
  });

  describe('deleteAccount', () => {
    it('marks the profile deleting, queues the purge, then disables and signs out the user', async () => {
      const session = newSession('google_1234567890');
      const order: string[] = [];
      requestPurge.mockImplementation(async () => {
        order.push('purge');
      });
      disableUser.mockImplementation(async () => {
        order.push('disable');
      });
      signOutUser.mockImplementation(async () => {
        order.push('signout');
      });

      expect(await deleteAccount(deps(), session)).toEqual({
        status: 202,
        body: { status: 'deleting' },
      });
      expect(requestPurge).toHaveBeenCalledWith({
        sub: session.sub,
        username: 'google_1234567890',
      });
      expect(disableUser).toHaveBeenCalledWith('google_1234567890');
      expect(signOutUser).toHaveBeenCalledWith('google_1234567890');
      expect(order).toEqual(['purge', 'disable', 'signout']);
      expect(await profileOf(session.sub)).toMatchObject({
        status: 'deleting',
        deletionRequestedAt: '2026-10-15T12:00:00.000Z',
      });
    });

    it('uses the sub as the username when the token had none', async () => {
      const session = { ...newSession(), username: undefined };
      await deleteAccount(deps(), session);
      expect(disableUser).toHaveBeenCalledWith(session.sub);
    });

    it('puts the profile back and answers 503 when the purge cannot be queued', async () => {
      const session = newSession();
      await completeOnboarding(deps(), session, ACCEPT);
      requestPurge.mockRejectedValueOnce(new Error('SQS unavailable'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(await deleteAccount(deps(), session)).toMatchObject({
        status: 503,
        body: { code: 'deletion_failed' },
      });
      expect(disableUser).not.toHaveBeenCalled();
      const profile = await profileOf(session.sub);
      expect(profile).toMatchObject({ status: 'active', tosVersion: TOS_VERSION });
      expect(profile).not.toHaveProperty('deletionRequestedAt');
      vi.mocked(console.error).mockRestore();
    });

    it('still answers 202 when Cognito fails, since the purge deletes the user', async () => {
      const session = newSession();
      disableUser.mockRejectedValueOnce(new Error('Cognito unavailable'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect((await deleteAccount(deps(), session)).status).toBe(202);
      expect(signOutUser).toHaveBeenCalled();
      expect(purges).toHaveLength(1);
      vi.mocked(console.error).mockRestore();
    });

    it('can be asked again while the deletion is under way', async () => {
      const session = newSession();
      await deleteAccount(deps(), session);
      expect((await deleteAccount(deps(), session)).status).toBe(202);
      expect(purges).toHaveLength(2);
      expect((await profileOf(session.sub))?.status).toBe('deleting');
    });
  });
});
