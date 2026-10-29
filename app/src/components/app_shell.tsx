'use client';

import { ImagesIcon, PencilIcon, ShieldIcon, SparklesIcon, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { ADMIN_PATH } from '../lib/admin_access';
import { EDIT_PATH, GALLERY_PATH, GENERATE_PATH } from '../lib/site';
import { PictoraIcon } from './pictora_icon';
import { SidebarAccount } from './sidebar_account';
import { SidebarHistory } from './sidebar_history';
import { ThemeSwitcher } from './theme_switcher';

interface PageLink {
  title: string;
  href: string;
  Icon: LucideIcon;
}

/** The signed-in pages the sidebar links to, in order. The account page is in the user menu instead. */
export const PAGE_LINKS: readonly PageLink[] = [
  { title: 'Generate', href: GENERATE_PATH, Icon: SparklesIcon },
  { title: 'Gallery', href: GALLERY_PATH, Icon: ImagesIcon },
  { title: 'Edit', href: EDIT_PATH, Icon: PencilIcon },
];

const ADMIN_LINK: PageLink = { title: 'Admin', href: ADMIN_PATH, Icon: ShieldIcon };

/** True when `pathname` is the page at `href` or one under it, such as an image under the gallery. */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface AppShellProps {
  email: string;
  /** Shows the Admin link, for the `admins` group. */
  admin: boolean;
  /** Whether the sidebar starts expanded on desktop: the state the user last left it in, collapsed at first. */
  defaultOpen: boolean;
  /** Shown under each page, inside the inset. */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The frame of every signed-in page: a sidebar with the Pictora icon and name, links to each page, the user's
 * recent images, today's points and, last, the user menu; and a page header with the theme switcher at its
 * right edge. On desktop the sidebar is shadcn's floating variant, an inset rounded panel, and collapses to
 * icons (the trigger, or Ctrl/Cmd+B); on mobile it opens as a sheet.
 */
export function AppShell({ email, admin, defaultOpen, footer, children }: AppShellProps) {
  const pathname = usePathname();

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar email={email} admin={admin} pathname={pathname} />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-[orientation=vertical]:h-4 md:hidden"
          />
          <Link
            href={GENERATE_PATH}
            className="flex items-center gap-2 font-semibold text-foreground no-underline md:hidden"
          >
            <PictoraIcon className="size-6" />
            Pictora
          </Link>
          <div className="ml-auto">
            <ThemeSwitcher />
          </div>
        </header>
        <div className="mx-auto w-full max-w-260 flex-1 px-4 pt-6 pb-12">{children}</div>
        {footer}
      </SidebarInset>
    </SidebarProvider>
  );
}

function AppSidebar({
  email,
  admin,
  pathname,
}: {
  email: string;
  admin: boolean;
  pathname: string;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const links = admin ? [...PAGE_LINKS, ADMIN_LINK] : PAGE_LINKS;
  // On mobile the sheet closes once a link is chosen.
  const closeOnMobile = () => isMobile && setOpenMobile(false);

  return (
    <Sidebar variant="floating" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Pictora">
              <Link href={GENERATE_PATH} onClick={closeOnMobile}>
                <PictoraIcon className="size-8" />
                <span className="truncate text-base font-semibold">Pictora</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      {/* Only the history scrolls; the header, page links and footer stay in place. */}
      <SidebarContent className="overflow-hidden">
        <SidebarGroup className="shrink-0">
          <SidebarGroupContent>
            <nav aria-label="Pages">
              <SidebarMenu>
                {links.map(({ title, href, Icon }) => {
                  const active = isActivePath(pathname, href);
                  return (
                    <SidebarMenuItem key={href}>
                      <SidebarMenuButton asChild isActive={active} tooltip={title}>
                        <Link
                          href={href}
                          aria-current={active ? 'page' : undefined}
                          onClick={closeOnMobile}
                        >
                          <Icon />
                          <span>{title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarHistory />
      </SidebarContent>
      <SidebarFooter>
        {/* Points, then the user menu as the bottom-most item. */}
        <SidebarAccount email={email} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
