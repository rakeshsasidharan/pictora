import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  emailDomain,
  isAbuseFlag,
  isDisposableEmail,
  signUpFlagPk,
  signUpIpPk,
} from '../src/abuse.js';
import { hashIp, recordSignUp } from '../src/abuse_store.js';

const DISPOSABLE = new Set(['mailinator.com', 'tempmail.dev', 'guerrillamail.co.uk']);

describe('emailDomain', () => {
  it.each([
    ['user@Example.COM', 'example.com'],
    ['a@b@sub.example.org', 'sub.example.org'],
    ['user@example.com.', 'example.com'],
    ['no-at-sign', undefined],
    ['user@', undefined],
  ])('reads %s as %s', (email, domain) => {
    expect(emailDomain(email)).toBe(domain);
  });
});

describe('isDisposableEmail', () => {
  it.each([
    'someone@mailinator.com',
    'SOMEONE@MAILINATOR.COM',
    'someone@MailInator.Com',
    'someone@x.mailinator.com',
    'someone@deep.x.tempmail.dev',
    'someone@guerrillamail.co.uk',
  ])('matches %s', (email) => {
    expect(isDisposableEmail(email, DISPOSABLE)).toBe(true);
  });

  it.each([
    'someone@gmail.com',
    'someone@notmailinator.com',
    'someone@mailinator.com.example.org',
    'someone@co.uk',
    'not-an-email',
  ])('does not match %s', (email) => {
    expect(isDisposableEmail(email, DISPOSABLE)).toBe(false);
  });
});

describe('abuse keys and flags', () => {
  it('keys the sign-up marker by the email in lower case', () => {
    expect(signUpFlagPk(' Someone@Example.com ')).toBe('SIGNUP#someone@example.com');
    expect(signUpIpPk('2026-10-19')).toBe('SIGNUPIP#2026-10-19');
  });

  it('knows the flags', () => {
    expect(isAbuseFlag('disposable_email')).toBe(true);
    expect(isAbuseFlag('many_accounts')).toBe(true);
    expect(isAbuseFlag('other')).toBe(false);
  });

  it('hashes IPs so none are stored raw', () => {
    expect(hashIp('203.0.113.7')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashIp('203.0.113.7')).toBe(hashIp(' 203.0.113.7 '));
    expect(hashIp('203.0.113.7')).not.toBe(hashIp('203.0.113.8'));
  });
});

// Runs against DynamoDB Local when DYNAMODB_ENDPOINT is set, as in CI (tech design 13).
const endpoint = process.env.DYNAMODB_ENDPOINT;

describe.skipIf(!endpoint)('recordSignUp against DynamoDB Local', () => {
  const tableName = `pictora-abuse-test-${Date.now()}`;
  const raw = new DynamoDBClient({
    endpoint,
    region: 'us-west-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const client = DynamoDBDocumentClient.from(raw);
  const table = { client, tableName };
  const now = new Date('2026-10-19T08:00:00.000Z');
  const marker = async (email: string) =>
    (
      await client.send(
        new GetCommand({ TableName: tableName, Key: { PK: signUpFlagPk(email), SK: 'ABUSE' } }),
      )
    ).Item;

  beforeAll(async () => {
    await raw.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: ['PK', 'SK'].map((AttributeName) => ({
          AttributeName,
          AttributeType: 'S',
        })),
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
      }),
    );
  });
  afterAll(async () => {
    await raw.send(new DeleteTableCommand({ TableName: tableName }));
  });

  it('leaves a clean sign-up alone', async () => {
    expect(await recordSignUp(table, DISPOSABLE, { email: 'ok@gmail.com', now })).toBeUndefined();
    expect(await marker('ok@gmail.com')).toBeUndefined();
  });

  it('marks a disposable email for the profile to pick up', async () => {
    const flag = await recordSignUp(table, DISPOSABLE, { email: 'Temp@X.Mailinator.com', now });
    expect(flag).toBe('disposable_email');
    expect(await marker('temp@x.mailinator.com')).toMatchObject({
      abuseFlag: 'disposable_email',
      createdAt: now.toISOString(),
      ttl: Math.floor(now.getTime() / 1000) + 30 * 86_400,
    });
  });

  it('flags sign-ups after the third from one IP in a day', async () => {
    const flags = [];
    for (let i = 1; i <= 5; i++) {
      flags.push(
        await recordSignUp(table, DISPOSABLE, {
          email: `user${i}@gmail.com`,
          sourceIp: '198.51.100.4',
          now,
        }),
      );
    }
    expect(flags).toEqual([undefined, undefined, undefined, 'many_accounts', 'many_accounts']);
    expect(await marker('user3@gmail.com')).toBeUndefined();
    expect(await marker('user4@gmail.com')).toMatchObject({ abuseFlag: 'many_accounts' });

    // Another IP, and the same IP on another day, start their own counts.
    expect(
      await recordSignUp(table, DISPOSABLE, {
        email: 'other@gmail.com',
        sourceIp: '198.51.100.5',
        now,
      }),
    ).toBeUndefined();
    expect(
      await recordSignUp(table, DISPOSABLE, {
        email: 'tomorrow@gmail.com',
        sourceIp: '198.51.100.4',
        now: new Date('2026-10-20T08:00:00.000Z'),
      }),
    ).toBeUndefined();
  });

  it('keeps the disposable flag when the IP is also over the limit', async () => {
    const ip = '198.51.100.9';
    for (let i = 0; i < 3; i++) {
      await recordSignUp(table, DISPOSABLE, { email: `p${i}@gmail.com`, sourceIp: ip, now });
    }
    expect(
      await recordSignUp(table, DISPOSABLE, { email: 'x@tempmail.dev', sourceIp: ip, now }),
    ).toBe('disposable_email');
  });
});
