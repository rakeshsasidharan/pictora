'use client';

import { useEffect, useRef } from 'react';

/** The window event that says the user's images or points changed. */
export const IMAGES_CHANGED_EVENT = 'pictora:images-changed';

/**
 * Tells the sidebar that the user's images changed: a job finished, an image was uploaded or deleted. Its
 * history and points refresh. Does nothing on the server.
 */
export function notifyImagesChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(IMAGES_CHANGED_EVENT));
}

/** Calls `onChange` each time `notifyImagesChanged()` runs, while the component is mounted. */
export function useImagesChanged(onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    const listener = () => onChangeRef.current();
    window.addEventListener(IMAGES_CHANGED_EVENT, listener);
    return () => window.removeEventListener(IMAGES_CHANGED_EVENT, listener);
  }, []);
}
