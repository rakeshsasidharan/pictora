import { TOS_VERSION } from '@pictora/core';
import { legalHtml, legalPage, type LegalSlug } from '../lib/legal_pages';

/** A legal page, rendered on the server from its Markdown file. */
export function LegalDocument({ slug }: { slug: LegalSlug }) {
  const page = legalPage(slug);
  return (
    <main
      data-slot="legal-page"
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pt-8 pb-12"
    >
      {page.acceptedAtOnboarding && (
        <p className="text-sm text-muted-foreground">Version {TOS_VERSION}</p>
      )}
      {/* Rendered from our own Markdown with raw HTML escaped (see legal_pages.ts). */}
      <article
        className="prose max-w-none prose-neutral dark:prose-invert prose-headings:tracking-tight prose-a:font-medium prose-blockquote:font-normal prose-blockquote:not-italic [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none"
        dangerouslySetInnerHTML={{ __html: legalHtml(slug) }}
      />
    </main>
  );
}
