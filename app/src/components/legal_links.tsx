import Link from 'next/link';
import { LEGAL_PAGES } from '../lib/legal_pages';

/** Links to the terms, content policy and privacy policy, for the footer and the onboarding page. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <ul className={className ?? 'legal-links'}>
      {LEGAL_PAGES.map((page) => (
        <li key={page.slug}>
          <Link href={page.path}>{page.title}</Link>
        </li>
      ))}
    </ul>
  );
}
