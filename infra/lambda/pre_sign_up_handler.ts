import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import disposableDomains from 'disposable-email-domains-js/dist/dict/disposable_email_blocklist.json' with { type: 'json' };
// Imported from source and bundled by esbuild, so synth and tests don't need packages/core built first.
import { recordSignUp, type AbuseTable } from '../../packages/core/src/abuse_store.js';
import { BETA_REJECTION_MESSAGE, betaModeFromEnv } from '../../packages/core/src/beta.js';
import { isAllowlisted } from '../../packages/core/src/beta_store.js';

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

/** Sign-ups an admin makes with `admin-create-user`, which the beta allowlist doesn't apply to. */
export const ADMIN_CREATE_USER_TRIGGER = 'PreSignUp_AdminCreateUser';

/** What Cognito shows when the allowlist can't be read in beta mode; the sign-up is refused, so it can be retried. */
export const BETA_CHECK_FAILED_MESSAGE = 'Sign-up is unavailable right now. Try again in a minute.';

let table: AbuseTable | undefined;

/** The Lambda entry point; the table name comes from `TABLE_NAME`, and `BETA_MODE=true` turns the allowlist on. */
export async function handler(event: PreSignUpEvent): Promise<PreSignUpEvent> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is not set');
  table ??= { client: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName };
  return preSignUp(event, table, () => new Date(), {
    betaMode: betaModeFromEnv(process.env.BETA_MODE),
  });
}

/**
 * The Cognito pre-sign-up trigger (tech design 8), for every new account, email or Google (`PreSignUp_SignUp`
 * and `PreSignUp_ExternalProvider`):
 *
 * 1. In beta mode, refuses an email that isn't on the private beta allowlist, in any case, by throwing
 *    `BETA_REJECTION_MESSAGE`, which Cognito shows on its sign-in page or passes back to the app's callback.
 *    It fails closed: if the allowlist can't be read, the sign-up is refused with a try-again message. Accounts
 *    an admin creates by hand (`PreSignUp_AdminCreateUser`) skip the allowlist.
 * 2. Checks the account for abuse signals and leaves a marker for the app to set `abuseFlag` on the profile it
 *    creates. This never blocks a sign-up: on any error it logs and lets the sign-up through unflagged.
 */
export async function preSignUp(
  event: PreSignUpEvent,
  abuseTable: AbuseTable,
  now: () => Date,
  { betaMode }: { betaMode: boolean } = { betaMode: false },
): Promise<PreSignUpEvent> {
  const email = event.request.userAttributes.email;
  if (betaMode && event.triggerSource !== ADMIN_CREATE_USER_TRIGGER) {
    await checkAllowlist(abuseTable, email, event.triggerSource);
  }
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

/** Throws Cognito's refusal unless the email is on the allowlist. */
async function checkAllowlist(
  betaTable: AbuseTable,
  email: string | undefined,
  triggerSource: string,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = email ? await isAllowlisted(betaTable, email) : false;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'ERROR',
        message: 'Beta allowlist check failed; sign-up refused',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw new Error(BETA_CHECK_FAILED_MESSAGE, { cause: error });
  }
  if (!allowed) {
    console.log(
      JSON.stringify({
        level: 'INFO',
        message: 'Sign-up refused: not on the beta allowlist',
        triggerSource,
      }),
    );
    throw new Error(BETA_REJECTION_MESSAGE);
  }
}
