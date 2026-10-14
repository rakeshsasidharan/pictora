import { CONTACT_EMAIL } from '../lib/site';
import { LegalLinks } from './legal_links';

/** The footer on every page: the legal pages and how to contact us. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav aria-label="Legal">
        <LegalLinks />
      </nav>
      <p>
        Contact: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </footer>
  );
}
