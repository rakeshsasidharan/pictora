import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { MeBody } from '../lib/jobs';
import { DeleteAccount } from './delete_account';

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** The account page's content: profile details and today's points in a card, then account deletion. */
export function AccountDetails({ me, method }: { me: MeBody; method: string }) {
  const fields = [
    { label: 'Email', value: me.email },
    { label: 'Sign-in method', value: method },
    {
      label: 'Member since',
      value: me.memberSince ? DATE_FORMAT.format(new Date(me.memberSince)) : '—',
    },
    {
      label: 'Points today',
      value: `${me.pointsLeft} of ${me.dailyLimit} left (${me.pointsUsed} used). Points reset at 00:00 UTC.`,
    },
  ];

  return (
    <div data-slot="account-page" className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-semibold">Account</h1>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Profile</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            {fields.map((field) => (
              <div key={field.label} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="break-words">{field.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <DeleteAccount />
    </div>
  );
}
