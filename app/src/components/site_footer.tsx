import { CONTACT_EMAIL } from '../lib/site';
import { LegalLinks } from './legal_links';

/** The footer on every page: the legal pages and how to contact us. */
export function SiteFooter() {
  return (
    <footer
      data-slot="site-footer"
      className="flex flex-col items-center gap-2 border-t bg-muted/40 px-4 py-4 text-center text-sm text-muted-foreground"
    >
      <nav aria-label="Legal">
        <LegalLinks />
      </nav>
      <p className="break-all sm:break-normal">
        Contact:{' '}
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {CONTACT_EMAIL}
        </a>
      </p>
    </footer>
  );
}
