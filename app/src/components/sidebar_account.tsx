'use client';

import { ChevronsUpDownIcon, CoinsIcon, LogOutIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown_menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { LOGOUT_PATH } from '../lib/cognito_oauth';
import { useImagesChanged } from '../lib/images_changed';
import type { MeBody } from '../lib/jobs';
import { ACCOUNT_PATH } from '../lib/site';

type PointsState =
  { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; left: number; limit: number };

/** Reads today's points from `GET /api/me`. */
async function fetchPoints(): Promise<PointsState> {
  try {
    const response = await fetch('/api/me', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const me = (await response.json()) as MeBody;
    return { phase: 'ready', left: me.pointsLeft, limit: me.dailyLimit };
  } catch {
    return { phase: 'error' };
  }
}

/**
 * Today's points left (LIM-1), from `GET /api/me`, read again whenever `notifyImagesChanged()` says a job
 * finished. Collapsed to icons, it shows as the icon with a tooltip.
 */
export function SidebarPoints() {
  const [state, setState] = useState<PointsState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void fetchPoints().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useImagesChanged(() => {
    // Points already showing stay if the refresh fails.
    void fetchPoints().then((next) =>
      setState((previous) =>
        next.phase === 'error' && previous.phase === 'ready' ? previous : next,
      ),
    );
  });

  const text =
    state.phase === 'ready'
      ? `${state.left} of ${state.limit} points left today`
      : state.phase === 'error'
        ? 'Points unavailable'
        : undefined;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={text ?? 'Points'} className="hover:bg-transparent">
        <div aria-live="polite">
          <CoinsIcon aria-hidden />
          {text ? (
            <span className="truncate">{text}</span>
          ) : (
            <Skeleton aria-label="Loading points" className="h-4 w-36" />
          )}
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** The user menu: the email, a link to the account page, and sign-out (a POST to `/auth/logout`). */
export function UserMenu({ email }: { email: string }) {
  const { isMobile } = useSidebar();
  const signOutForm = useRef<HTMLFormElement>(null);

  return (
    <SidebarMenuItem>
      <form ref={signOutForm} method="post" action={LOGOUT_PATH} className="hidden" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            tooltip={email}
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-accent">
              <UserIcon aria-hidden className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate">{email}</span>
            <ChevronsUpDownIcon aria-hidden className="ml-auto size-4" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={isMobile ? 'bottom' : 'right'}
          align="end"
          sideOffset={4}
          className="min-w-56"
        >
          <DropdownMenuLabel className="truncate font-normal">{email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={ACCOUNT_PATH}>
              <UserIcon />
              Account
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => signOutForm.current?.requestSubmit()}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

/** The sidebar footer's menu: points, then the user menu. */
export function SidebarAccount({ email }: { email: string }) {
  return (
    <SidebarMenu>
      <SidebarPoints />
      <UserMenu email={email} />
    </SidebarMenu>
  );
}
