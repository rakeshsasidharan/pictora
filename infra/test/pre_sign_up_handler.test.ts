import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BETA_REJECTION_MESSAGE, isBetaRejection } from '../../packages/core/src/beta.js';
import {
  BETA_CHECK_FAILED_MESSAGE,
  DISPOSABLE_DOMAINS,
  handler,
  preSignUp,
  type PreSignUpEvent,
} from '../lambda/pre_sign_up_handler.js';

const NOW = new Date('2026-10-19T08:00:00.000Z');

function event(
  email: string | undefined,
  ipAddress?: string,
  triggerSource = 'PreSignUp_SignUp',
): PreSignUpEvent {
  return {
    triggerSource,
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

/** A document client whose allowlist holds `allowlisted` (lower-case SKs), recording each command. */
function betaTable(allowlisted: string[]) {
  const commands: unknown[] = [];
  const send = vi.fn(async (command: unknown) => {
    commands.push(command);
    if (command instanceof GetCommand) {
      const { PK, SK } = command.input.Key as { PK: string; SK: string };
      return PK === 'BETA#ALLOWLIST' && allowlisted.includes(SK) ? { Item: { PK } } : {};
    }
    if (command instanceof UpdateCommand) return { Attributes: { count: 1 } };
    return {};
  });
  return {
    table: { client: { send } as unknown as DynamoDBDocumentClient, tableName: 'pictora-prod' },
    commands,
  };
}

describe('pre-sign-up trigger in beta mode', () => {
  const beta = { betaMode: true };
  afterEach(() => vi.restoreAllMocks());

  it('lets an allowlisted email sign up, in any case', async () => {
    const { table, commands } = betaTable(['invited@example.com']);
    const input = event('  Invited@Example.COM ');
    await expect(preSignUp(structuredClone(input), table, () => NOW, beta)).resolves.toEqual(input);
    const get = commands[0] as GetCommand;
    expect(get).toBeInstanceOf(GetCommand);
    expect(get.input.Key).toEqual({ PK: 'BETA#ALLOWLIST', SK: 'invited@example.com' });
  });

  it('refuses an email that is not on the allowlist, with the private beta message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { table, commands } = betaTable(['invited@example.com']);
    await expect(preSignUp(event('stranger@example.com'), table, () => NOW, beta)).rejects.toThrow(
      BETA_REJECTION_MESSAGE,
    );
    // Refused before the abuse check, so nothing is written for an account that won't exist.
    expect(commands.every((command) => command instanceof GetCommand)).toBe(true);
    // Cognito wraps the message; the app's callback recognises it.
    expect(isBetaRejection(`PreSignUp failed with error ${BETA_REJECTION_MESSAGE}.`)).toBe(true);
  });

  it('applies the same rule to Google sign-ups (the federated trigger source)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { table } = betaTable(['invited@gmail.com']);
    await expect(
      preSignUp(
        event('stranger@gmail.com', undefined, 'PreSignUp_ExternalProvider'),
        table,
        () => NOW,
        beta,
      ),
    ).rejects.toThrow(BETA_REJECTION_MESSAGE);
    const input = event('Invited@gmail.com', undefined, 'PreSignUp_ExternalProvider');
    await expect(preSignUp(structuredClone(input), table, () => NOW, beta)).resolves.toEqual(input);
  });

  it('refuses a sign-up without an email', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { table } = betaTable([]);
    await expect(preSignUp(event(undefined), table, () => NOW, beta)).rejects.toThrow(
      BETA_REJECTION_MESSAGE,
    );
  });

  it('lets accounts an admin creates by hand through', async () => {
    const { table, commands } = betaTable([]);
    const input = event('tester@example.com', undefined, 'PreSignUp_AdminCreateUser');
    await expect(preSignUp(structuredClone(input), table, () => NOW, beta)).resolves.toEqual(input);
    expect(commands.some((command) => command instanceof GetCommand)).toBe(false);
  });

  it('fails closed with a try-again message when the allowlist cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const table = {
      client: {
        send: async () => {
          throw new Error('DynamoDB down');
        },
      } as unknown as DynamoDBDocumentClient,
      tableName: 'pictora-prod',
    };
    await expect(preSignUp(event('invited@example.com'), table, () => NOW, beta)).rejects.toThrow(
      BETA_CHECK_FAILED_MESSAGE,
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sign-up refused'));
  });

  it('allows every email with beta mode off, without reading the allowlist', async () => {
    const { table, commands } = betaTable([]);
    const input = event('anyone@example.com');
    await expect(
      preSignUp(structuredClone(input), table, () => NOW, { betaMode: false }),
    ).resolves.toEqual(input);
    expect(commands).toEqual([]);
  });

  it('reads BETA_MODE in the entry point', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('TABLE_NAME', 'pictora-prod');
    vi.stubEnv('BETA_MODE', 'true');
    vi.stubEnv('AWS_REGION', 'us-west-2');
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, 'send')
      .mockImplementation((async () => ({})) as never);
    await expect(handler(event('stranger@example.com'))).rejects.toThrow(BETA_REJECTION_MESSAGE);
    expect(send).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
