import { NextResponse } from 'next/server';
import { authConfig } from '../../../lib/auth_config';
import { clearSessionCookies } from '../../../lib/auth_cookies';
import { logoutUrl } from '../../../lib/cognito_oauth';

export const dynamic = 'force-dynamic';

/**
 * Signs out (tech design 8): clears the session cookies and sends the browser to Cognito's logout endpoint,
 * which ends the managed login session and returns to the home page. A POST, so the proxy's `Origin` check
 * stops other sites from signing users out.
 */
export async function POST(): Promise<Response> {
  const config = await authConfig();
  const response = config
    ? NextResponse.redirect(logoutUrl(config), 303)
    : NextResponse.json({ signedOut: true });
  clearSessionCookies(response);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
