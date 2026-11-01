import {
  ChevronRightIcon,
  FileTextIcon,
  LockIcon,
  MailIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LEGAL_PAGES, type LegalSlug } from '../lib/legal_pages';
import { CONTACT_EMAIL } from '../lib/site';

/** Each legal page's icon and a line on what it covers, keyed by slug so the page list stays in `LEGAL_PAGES`. */
const LEGAL_PAGE_DETAILS: Record<LegalSlug, { Icon: LucideIcon; summary: string }> = {
  terms: { Icon: FileTextIcon, summary: 'The rules for using Pictora' },
  'content-policy': { Icon: ShieldCheckIcon, summary: 'What you can and can’t create' },
  privacy: { Icon: LockIcon, summary: 'What we keep about you, and why' },
};

/** A row of the card: an icon in a tile, a title and a line of detail, then what the row opens. */
const ROW_CLASS =
  'group flex min-w-0 items-center gap-3 rounded-md px-2 py-3 text-foreground no-underline outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50';
const ICON_TILE_CLASS =
  'flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground group-hover:text-foreground';

function RowText({ title, detail }: { title: string; detail: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-sm wrap-break-word text-muted-foreground">{detail}</span>
    </span>
  );
}

/**
 * The account page's Legal and support card (#161), which replaced the site footer on signed-in pages: a row
 * for each legal page, and the contact email for questions, feedback or reporting a problem.
 */
export function LegalSupportCard() {
  return (
    <Card data-slot="legal-support">
      <CardHeader>
        <CardTitle>
          <h2>Legal and support</h2>
        </CardTitle>
        <CardDescription>The terms you agreed to, and how to reach us.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <nav aria-label="Legal">
          <ul className="-mx-2 flex flex-col divide-y">
            {LEGAL_PAGES.map((page) => {
              const { Icon, summary } = LEGAL_PAGE_DETAILS[page.slug];
              return (
                <li key={page.slug}>
                  <Link href={page.path} className={ROW_CLASS}>
                    <span className={ICON_TILE_CLASS}>
                      <Icon aria-hidden="true" className="size-4" />
                    </span>
                    <RowText title={page.title} detail={summary} />
                    <ChevronRightIcon
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex flex-col gap-1 border-t pt-4">
          <h3 className="text-sm font-medium text-muted-foreground">Contact</h3>
          <a href={`mailto:${CONTACT_EMAIL}`} className={`${ROW_CLASS} -mx-2`}>
            <span className={ICON_TILE_CLASS}>
              <MailIcon aria-hidden="true" className="size-4" />
            </span>
            <RowText title="Questions, feedback or a problem to report" detail={CONTACT_EMAIL} />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
