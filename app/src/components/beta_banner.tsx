import { FlaskConicalIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CONTACT_EMAIL } from '../lib/site';

/** The beta feedback email, with a subject so it's easy to find. */
export const BETA_FEEDBACK_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Pictora beta feedback')}`;

/** Above every signed-in page while beta mode is on (M4): says Pictora is in private beta and asks for feedback. */
export function BetaBanner() {
  return (
    <Alert data-slot="beta-banner" role="note" className="mb-6" aria-label="Private beta">
      <FlaskConicalIcon aria-hidden="true" />
      <AlertTitle>Pictora is in private beta</AlertTitle>
      <AlertDescription>
        <p>
          Thanks for trying it out. Tell us what works and what doesn’t:{' '}
          <a
            href={BETA_FEEDBACK_HREF}
            className="font-medium text-foreground underline underline-offset-4"
          >
            send feedback
          </a>
          .
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** On the landing page after a sign-up the beta allowlist refused (`?signin=private_beta`). */
export function BetaRejectedNotice() {
  return (
    <Alert data-slot="beta-rejected" className="text-left">
      <FlaskConicalIcon aria-hidden="true" />
      <AlertTitle>Pictora is in private beta</AlertTitle>
      <AlertDescription>
        <p>
          Sign-ups are by invitation only for now, and that email isn’t on the list. To ask for an
          invite, email{' '}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="font-medium break-all text-foreground underline underline-offset-4"
          >
            {CONTACT_EMAIL}
          </a>
          . Pictora opens to everyone soon.
        </p>
      </AlertDescription>
    </Alert>
  );
}
