/** Methods that never change state; every other method needs a matching `Origin` (tech design 8). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isStateChanging(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * CSRF check on top of the SameSite cookies: a state-changing request must carry an `Origin` header equal to
 * the site's origin. Safe methods always pass. Without a known site URL, state-changing requests are refused.
 */
export function originAllowed(
  method: string,
  originHeader: string | null,
  siteUrl: string | undefined,
): boolean {
  if (!isStateChanging(method)) return true;
  if (!originHeader || !siteUrl) return false;
  try {
    return new URL(siteUrl).origin === originHeader;
  } catch {
    return false;
  }
}
