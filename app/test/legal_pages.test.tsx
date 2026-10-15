import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOS_VERSION } from '@pictora/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ContentPolicyPage from '../src/app/content-policy/page';
import PrivacyPage from '../src/app/privacy/page';
import TermsPage from '../src/app/terms/page';
import {
  LEGAL_CONTENT_DIR,
  LEGAL_DRAFT_NOTICE,
  LEGAL_PAGES,
  legalMarkdown,
  renderLegalMarkdown,
  type LegalSlug,
} from '../src/lib/legal_pages';
import { CONTACT_EMAIL } from '../src/lib/site';

/** The sections issue #29 asks each page to cover. */
const REQUIRED_HEADINGS: Record<LegalSlug, string[]> = {
  terms: [
    'Terms of service',
    'Eligibility',
    'Acceptable use',
    'Ownership of outputs',
    'No warranty',
    'Termination',
  ],
  'content-policy': [
    'Content policy',
    'Not allowed',
    'Real people',
    'Consequences',
    'How to report',
  ],
  privacy: [
    'Privacy policy',
    'Data we collect',
    'Providers that process your prompts',
    'No training on your data',
    'Retention',
    'Where your data is stored',
    'Contact',
  ],
};

function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((match) => match[1] ?? '');
}

describe('legal Markdown files', () => {
  it.each(LEGAL_PAGES.map((page) => [page.slug, page.file] as const))(
    '%s exists as %s',
    (_slug, file) => {
      expect(existsSync(join(process.cwd(), LEGAL_CONTENT_DIR, file))).toBe(true);
    },
  );

  it.each(Object.entries(REQUIRED_HEADINGS))('%s has the required sections', (slug, required) => {
    const found = headings(legalMarkdown(slug as LegalSlug));
    expect(found[0]).toBe(required[0]);
    for (const heading of required) expect(found).toContain(heading);
  });

  it.each(LEGAL_PAGES.map((page) => [page.slug, page.file] as const))(
    '%s is marked as a draft pending legal review',
    (_slug, file) => {
      const source = readFileSync(join(process.cwd(), LEGAL_CONTENT_DIR, file), 'utf8');
      expect(source).toContain(LEGAL_DRAFT_NOTICE);
    },
  );

  it('covers the PRD trust and safety rules in the content policy', () => {
    const policy = legalMarkdown('content-policy');
    for (const rule of [
      'Sexual content involving minors',
      'Sexual content',
      'Graphic violence',
      'Hate',
      'Self-harm',
      'Real-person deepfakes',
      'Illegal activity',
      '3 blocked requests within 24 hours',
    ]) {
      expect(policy).toContain(rule);
    }
  });

  it('names the providers, the retention periods and the US-only service in the privacy policy', () => {
    const privacy = legalMarkdown('privacy');
    for (const fact of ['OpenAI', 'Google', 'AWS', '30 days', '90 days', 'US-only']) {
      expect(privacy).toContain(fact);
    }
  });

  it('fills in the contact email', () => {
    for (const page of LEGAL_PAGES) {
      const markdown = legalMarkdown(page.slug);
      expect(markdown).not.toContain('{{');
    }
    expect(legalMarkdown('privacy')).toContain(`mailto:${CONTACT_EMAIL}`);
  });
});

describe('renderLegalMarkdown', () => {
  it('escapes raw HTML and drops script links', () => {
    const html = renderLegalMarkdown(
      '<script>alert(1)</script>\n\n[click](javascript:alert(1)) [terms](/terms)',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('<a href="/terms">terms</a>');
  });
});

describe('legal pages', () => {
  it.each([
    ['terms', TermsPage, 'Terms of service', true],
    ['content-policy', ContentPolicyPage, 'Content policy', true],
    ['privacy', PrivacyPage, 'Privacy policy', false],
  ] as const)('%s renders its Markdown with the draft notice', (_slug, Page, title, versioned) => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`<p class="draft-notice" role="note">${LEGAL_DRAFT_NOTICE}</p>`);
    expect(html.includes(`Version ${TOS_VERSION}`)).toBe(versioned);
  });
});
