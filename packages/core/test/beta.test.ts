import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import {
  BETA_ALLOWLIST_PK,
  BETA_REJECTION_MESSAGE,
  betaAllowlistAddSchema,
  betaAllowlistSk,
  betaEmailSchema,
  betaModeFromEnv,
  isBetaRejection,
} from '../src/beta.js';
import {
  addToAllowlist,
  isAllowlisted,
  listAllowlist,
  removeFromAllowlist,
} from '../src/beta_store.js';

const NOW = new Date('2026-10-31T09:00:00.000Z');

function table(send: (command: unknown) => Promise<unknown>) {
  return { client: { send: vi.fn(send) } as unknown as DynamoDBDocumentClient, tableName: 't' };
}

describe('beta allowlist keys and schema', () => {
  it('keys each email in lower case under one partition', () => {
    expect(BETA_ALLOWLIST_PK).toBe('BETA#ALLOWLIST');
    expect(betaAllowlistSk(' Someone@Example.COM ')).toBe('someone@example.com');
  });

  it('trims and lower-cases a valid email, and rejects anything else', () => {
    expect(betaEmailSchema.parse('  Ana@Example.com ')).toBe('ana@example.com');
    for (const bad of ['', 'not-an-email', 'a@', '@example.com', `${'a'.repeat(250)}@x.io`, 42]) {
      expect(betaEmailSchema.safeParse(bad).success).toBe(false);
    }
    expect(betaAllowlistAddSchema.safeParse({ email: 'a@example.com', extra: 1 }).success).toBe(
      false,
    );
  });

  it('reads BETA_MODE as on only for true', () => {
    expect(betaModeFromEnv('true')).toBe(true);
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
      expect(betaModeFromEnv(value)).toBe(false);
    }
  });

  it('spots the beta rejection in Cognito’s error description', () => {
    expect(isBetaRejection(`PreSignUp failed with error ${BETA_REJECTION_MESSAGE}.`)).toBe(true);
    expect(isBetaRejection('PreSignUp failed with error Something else.')).toBe(false);
    expect(isBetaRejection(null)).toBe(false);
    expect(isBetaRejection(undefined)).toBe(false);
  });
});

describe('beta allowlist store', () => {
  it('looks an email up in lower case', async () => {
    const t = table(async (command) => {
      expect(command).toBeInstanceOf(GetCommand);
      const key = (command as GetCommand).input.Key;
      return key?.SK === 'listed@example.com' ? { Item: { PK: BETA_ALLOWLIST_PK } } : {};
    });
    await expect(isAllowlisted(t, 'Listed@Example.com')).resolves.toBe(true);
    await expect(isAllowlisted(t, 'other@example.com')).resolves.toBe(false);
  });

  it('adds an email once, keeping the first entry when added again', async () => {
    const stored = new Map<string, Record<string, unknown>>();
    const t = table(async (command) => {
      if (command instanceof PutCommand) {
        const item = command.input.Item as Record<string, unknown>;
        if (stored.has(item.SK as string)) {
          throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
        }
        stored.set(item.SK as string, item);
        return {};
      }
      if (command instanceof GetCommand) {
        return { Item: stored.get(command.input.Key?.SK as string) };
      }
      throw new Error('unexpected command');
    });
    const first = await addToAllowlist(t, { email: 'New@Example.com', addedBy: 'admin', now: NOW });
    expect(first).toEqual({
      email: 'new@example.com',
      addedAt: NOW.toISOString(),
      addedBy: 'admin',
    });
    const again = await addToAllowlist(t, {
      email: 'new@example.com',
      addedBy: 'other-admin',
      now: new Date('2026-11-01T00:00:00Z'),
    });
    expect(again).toEqual(first);
  });

  it('passes other errors on', async () => {
    const t = table(async () => {
      throw new Error('DynamoDB down');
    });
    await expect(
      addToAllowlist(t, { email: 'a@example.com', addedBy: 'admin', now: NOW }),
    ).rejects.toThrow('DynamoDB down');
  });

  it('removes an email, saying whether it was there', async () => {
    const t = table(async (command) => {
      expect(command).toBeInstanceOf(DeleteCommand);
      const key = (command as DeleteCommand).input.Key;
      return key?.SK === 'listed@example.com' ? { Attributes: { PK: BETA_ALLOWLIST_PK } } : {};
    });
    await expect(removeFromAllowlist(t, 'LISTED@example.com')).resolves.toBe(true);
    await expect(removeFromAllowlist(t, 'gone@example.com')).resolves.toBe(false);
  });

  it('lists every page, filling in items added by hand with only their keys', async () => {
    const t = table(async (command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      const { ExclusiveStartKey } = (command as QueryCommand).input;
      return ExclusiveStartKey
        ? { Items: [{ PK: BETA_ALLOWLIST_PK, SK: 'cli@example.com' }] }
        : {
            Items: [
              {
                PK: BETA_ALLOWLIST_PK,
                SK: 'a@example.com',
                email: 'a@example.com',
                addedAt: NOW.toISOString(),
                addedBy: 'admin',
              },
            ],
            LastEvaluatedKey: { PK: BETA_ALLOWLIST_PK, SK: 'a@example.com' },
          };
    });
    await expect(listAllowlist(t)).resolves.toEqual([
      { email: 'a@example.com', addedAt: NOW.toISOString(), addedBy: 'admin' },
      { email: 'cli@example.com', addedAt: '', addedBy: '' },
    ]);
  });
});
