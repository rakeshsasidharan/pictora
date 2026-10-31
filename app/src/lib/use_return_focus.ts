import { useCallback, useState } from 'react';

/**
 * For a dialog opened without a Radix trigger (#30): remembers what had the focus when the dialog mounted, and
 * returns the handler for the dialog content's `onCloseAutoFocus` that gives it back on close. Radix only
 * returns the focus to its own trigger, so without this it lands on the page body.
 */
export function useReturnFocus(): (event: Event) => void {
  // Read while rendering, before the dialog moves the focus inside itself.
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  return useCallback(
    (event: Event) => {
      if (!opener?.isConnected || opener === document.body) return;
      event.preventDefault();
      opener.focus();
    },
    [opener],
  );
}
