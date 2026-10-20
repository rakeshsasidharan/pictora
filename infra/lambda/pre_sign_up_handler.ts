import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import disposableDomains from 'disposable-email-domains-js/dist/dict/disposable_email_blocklist.json' with { type: 'json' };
// Imported from source and bundled by esbuild, so synth and tests don't need packages/core built first.
import { recordSignUp, type AbuseTable } from '../../packages/core/src/abuse_store.js';

/**
 * The disposable email domains, from the community-maintained list vendored as the npm package
 * `disposable-email-domains-js`, which Dependabot keeps up to date.
 */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(
  (disposableDomains as string[]).map((domain) => domain.toLowerCase()),
);

/** The subset of Cognito's pre-sign-up event this handler reads; the rest is returned untouched. */
export interface PreSignUpEvent {
  triggerSource: string;
  userName: string;
  request: {
    userAttributes: Record<string, string | undefined>;
    /**
     * Cognito passes context data, with the source IP, only when threat protection collects it. Without it
     * the many-accounts check is skipped.
     */
    userContextData?: { ipAddress?: string };
  };
  response: Record<string, unknown>;
}

let table: AbuseTable | undefined;

/** The Lambda entry point; the table name comes from `TABLE_NAME`. */
export async function handler(event: PreSignUpEvent): Promise<PreSignUpEvent> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is not set');
  table ??= { client: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName };
  return preSignUp(event, table, () => new Date());
}

/**
 * The Cognito pre-sign-up trigger (tech design 8): checks every new account, email or Google, for abuse
 * signals, and leaves a marker for the app to set `abuseFlag` on the profile it creates. It never blocks a
 * sign-up: on any error it logs and lets the sign-up through unflagged.
 */
export async function preSignUp(
  event: PreSignUpEvent,
  abuseTable: AbuseTable,
  now: () => Date,
): Promise<PreSignUpEvent> {
  const email = event.request.userAttributes.email;
  if (!email) return event;
  try {
    const flag = await recordSignUp(abuseTable, DISPOSABLE_DOMAINS, {
      email,
      sourceIp: event.request.userContextData?.ipAddress,
      now: now(),
    });
    if (flag) {
      console.log(
        JSON.stringify({
          level: 'INFO',
          message: 'Sign-up flagged',
          abuseFlag: flag,
          triggerSource: event.triggerSource,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'ERROR',
        message: 'Abuse check failed; sign-up allowed unflagged',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return event;
}
