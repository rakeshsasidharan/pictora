import { isAdmin } from './admin_access';
import { apiError, type ApiResult } from './jobs';
import type { Session } from './session';

/**
 * 403 unless the user is an admin. The proxy refuses non-admins first; route handlers check again, so an admin
 * route never runs for anyone else even if the proxy's matcher changes.
 */
export function adminRefusal(session: Session): ApiResult | undefined {
  return isAdmin(session) ? undefined : apiError('forbidden', 'Only admins can do this.');
}
