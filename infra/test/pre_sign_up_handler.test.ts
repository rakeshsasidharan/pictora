import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISPOSABLE_DOMAINS,
  handler,
  preSignUp,
  type PreSignUpEvent,
} from '../lambda/pre_sign_up_handler.js';

const NOW = new Date('2026-10-19T08:00:00.000Z');

function event(email: string | undefined, ipAddress?: string): PreSignUpEvent {
  return {
    triggerSource: 'PreSignUp_SignUp',
    userName: 'a1b2c3',
    request: {
      userAttributes: email ? { email } : {},
      ...(ipAddress ? { userContextData: { ipAddress } } : {}),
    },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  };
}

/** A document client that records each command; the IP counter answers with `ipCount`. */
function fakeTable(ipCount = 1) {
  const commands: unknown[] = [];
  const send = vi.fn(async (command: unknown) => {
    commands.push(command);
    if (command instanceof UpdateCommand) return { Attributes: { count: ipCount } };
    return {};
  });
  return {
    table: { client: { send } as unknown as DynamoDBDocumentClient, tableName: 'pictora-dev' },
    commands,
  };
}

describe('pre-sign-up trigger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('vendors the disposable domain list', () => {
    expect(DISPOSABLE_DOMAINS.size).toBeGreaterThan(1000);
    expect(DISPOSABLE_DOMAINS.has('mailinator.com')).toBe(true);
    expect(DISPOSABLE_DOMAINS.has('gmail.com')).toBe(false);
  });

  it('marks a disposable email and returns the event unchanged', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { table, commands } = fakeTable();
    const input = event('Someone@Sub.Mailinator.com');
    const output = await preSignUp(structuredClone(input), table, () => NOW);

    expect(output).toEqual(input);
    expect(commands).toHaveLength(1);
    const put = commands[0] as PutCommand;
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input.Item).toMatchObject({
      PK: 'SIGNUP#someone@sub.mailinator.com',
      SK: 'ABUSE',
      abuseFlag: 'disposable_email',
    });
  });

  it('writes nothing for a clean sign-up without an IP', async () => {
    const { table, commands } = fakeTable();
    await preSignUp(event('someone@gmail.com'), table, () => NOW);
    expect(commands).toEqual([]);
  });

  it('counts the source IP when Cognito passes it, flagging past the third sign-up', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const third = fakeTable(3);
    await preSignUp(event('three@gmail.com', '203.0.113.9'), third.table, () => NOW);
    expect(third.commands).toHaveLength(1);
    const update = third.commands[0] as UpdateCommand;
    expect(update.input.Key?.PK).toBe('SIGNUPIP#2026-10-19');
    expect(update.input.Key?.SK).not.toContain('203.0.113.9');

    const fourth = fakeTable(4);
    await preSignUp(event('four@gmail.com', '203.0.113.9'), fourth.table, () => NOW);
    expect((fourth.commands[1] as PutCommand).input.Item).toMatchObject({
      abuseFlag: 'many_accounts',
    });
  });

  it('lets the sign-up through when the check fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const input = event('someone@mailinator.com');
    const table = {
      client: {
        send: async () => {
          throw new Error('DynamoDB down');
        },
      } as unknown as DynamoDBDocumentClient,
      tableName: 'pictora-dev',
    };
    await expect(preSignUp(structuredClone(input), table, () => NOW)).resolves.toEqual(input);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sign-up allowed unflagged'));
  });

  it('ignores an event without an email', async () => {
    const { table, commands } = fakeTable();
    await preSignUp(event(undefined), table, () => NOW);
    expect(commands).toEqual([]);
  });

  it('needs the table name', async () => {
    vi.stubEnv('TABLE_NAME', '');
    await expect(handler(event('a@gmail.com'))).rejects.toThrow('TABLE_NAME is not set');
    vi.unstubAllEnvs();
  });
});
