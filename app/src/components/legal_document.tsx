import { TOS_VERSION } from '@pictora/core';
import { LEGAL_DRAFT_NOTICE, legalHtml, legalPage, type LegalSlug } from '../lib/legal_pages';

/** A legal page, rendered on the server from its Markdown file, with the draft notice until legal review. */
export function LegalDocument({ slug }: { slug: LegalSlug }) {
  const page = legalPage(slug);
  return (
    <main className="legal-page">
      <p className="draft-notice" role="note">
        {LEGAL_DRAFT_NOTICE}
      </p>
      {page.acceptedAtOnboarding && <p className="legal-version">Version {TOS_VERSION}</p>}
      {/* Rendered from our own Markdown with raw HTML escaped (see legal_pages.ts). */}
      <article className="legal-text" dangerouslySetInnerHTML={{ __html: legalHtml(slug) }} />
    </main>
  );
}
