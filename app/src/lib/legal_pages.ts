import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { CONTACT_EMAIL } from './site';

export type LegalSlug = 'terms' | 'content-policy' | 'privacy';

export interface LegalPage {
  slug: LegalSlug;
  /** The page's path on the site. */
  path: `/${LegalSlug}`;
  title: string;
  /** The Markdown source, in `app/content/legal/`. */
  file: string;
  /** Users accept this page at onboarding (AUTH-4), so it carries `TOS_VERSION`. */
  acceptedAtOnboarding: boolean;
}

/** The legal pages, in the order the footer and the onboarding page list them. */
export const LEGAL_PAGES: readonly LegalPage[] = [
  {
    slug: 'terms',
    path: '/terms',
    title: 'Terms of service',
    file: 'terms.md',
    acceptedAtOnboarding: true,
  },
  {
    slug: 'content-policy',
    path: '/content-policy',
    title: 'Content policy',
    file: 'content_policy.md',
    acceptedAtOnboarding: true,
  },
  {
    slug: 'privacy',
    path: '/privacy',
    title: 'Privacy policy',
    file: 'privacy.md',
    acceptedAtOnboarding: false,
  },
];

/** Shown on every legal page, and written at the top of each Markdown file, until legal review signs off. */
export const LEGAL_DRAFT_NOTICE = 'Draft, pending legal review';

/** The Markdown files' directory, relative to the app root (the server's working directory). */
export const LEGAL_CONTENT_DIR = join('content', 'legal');

const CONTACT_EMAIL_TOKEN = /\{\{CONTACT_EMAIL\}\}/g;

// Raw HTML in the Markdown is escaped rather than passed through, and markdown-it refuses `javascript:` and
// similar link targets, so the output is safe to put in the page.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

export function legalPage(slug: LegalSlug): LegalPage {
  const page = LEGAL_PAGES.find((candidate) => candidate.slug === slug);
  if (!page) throw new Error(`Unknown legal page: ${slug}`);
  return page;
}

/** The Markdown source of a legal page, with `{{CONTACT_EMAIL}}` filled in. */
export function legalMarkdown(slug: LegalSlug, root: string = process.cwd()): string {
  const source = readFileSync(join(root, LEGAL_CONTENT_DIR, legalPage(slug).file), 'utf8');
  return source.replace(CONTACT_EMAIL_TOKEN, CONTACT_EMAIL);
}

export function renderLegalMarkdown(source: string): string {
  return markdown.render(source);
}

const renderedPages = new Map<LegalSlug, string>();

/** A legal page as HTML. The files don't change while the server runs, so each is rendered once. */
export function legalHtml(slug: LegalSlug): string {
  let html = renderedPages.get(slug);
  if (html === undefined) {
    html = renderLegalMarkdown(legalMarkdown(slug));
    renderedPages.set(slug, html);
  }
  return html;
}
