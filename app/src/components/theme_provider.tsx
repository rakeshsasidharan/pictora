'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';

/**
 * Light, dark and system themes (tech design 3.3): `next-themes` puts `dark` on `<html>`, follows the OS while the
 * choice is System, and keeps the choice in local storage. Its inline script sets the class before the first
 * paint, so there is no flash of the wrong theme; it carries the CSP nonce when the proxy sends one.
 */
export function ThemeProvider(props: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    />
  );
}
