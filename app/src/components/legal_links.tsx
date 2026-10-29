import Link from 'next/link';
import { cn } from '@/lib/utils';
import { LEGAL_PAGES } from '../lib/legal_pages';

/** Links to the terms, content policy and privacy policy, for the footer and the onboarding page. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <ul className={cn('flex flex-wrap justify-center gap-x-5 gap-y-1', className)}>
      {LEGAL_PAGES.map((page) => (
        <li key={page.slug}>
          <Link
            href={page.path}
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {page.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}
