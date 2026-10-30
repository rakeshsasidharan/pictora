/**
 * How to scroll something into view: smoothly, unless the user asked for reduced motion (#30). CSS can't reach
 * `scrollIntoView({ behavior })`, so scripted scrolls ask here.
 */
export function scrollBehavior(): ScrollBehavior {
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  return reduced ? 'auto' : 'smooth';
}
