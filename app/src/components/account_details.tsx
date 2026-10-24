import type { MeBody } from '../lib/jobs';
import { DeleteAccount } from './delete_account';

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** The account page's content: profile details, today's points and account deletion. */
export function AccountDetails({ me, method }: { me: MeBody; method: string }) {
  return (
    <div className="account">
      <h1>Account</h1>
      <dl className="account-details">
        <dt>Email</dt>
        <dd>{me.email}</dd>
        <dt>Sign-in method</dt>
        <dd>{method}</dd>
        <dt>Member since</dt>
        <dd>{me.memberSince ? DATE_FORMAT.format(new Date(me.memberSince)) : '—'}</dd>
        <dt>Points today</dt>
        <dd>
          {me.pointsLeft} of {me.dailyLimit} left ({me.pointsUsed} used). Points reset at 00:00 UTC.
        </dd>
      </dl>
      <DeleteAccount />
    </div>
  );
}
