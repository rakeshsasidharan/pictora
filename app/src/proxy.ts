import { NextResponse, type NextRequest } from 'next/server';
import { authConfig } from './lib/auth_config';
import { authenticate } from './lib/auth_proxy';
import { expectedOriginSecret, ORIGIN_VERIFY_HEADER, verifyOrigin } from './lib/origin_verify';
import { sharedTokenVerifier } from './lib/token_verifier';

/**
 * Rejects requests that didn't come through CloudFront (tech design 3.1): the Function URL is public, so
 * without this check anyone could call the app directly and bypass the CDN. Then checks CSRF and the session
 * (tech design 8).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const result = await verifyOrigin(request.headers.get(ORIGIN_VERIFY_HEADER), {
    nodeEnv: process.env.NODE_ENV,
    expectedValue: () => expectedOriginSecret(),
  });
  if (result === 'forbidden') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const config = await authConfig();
  return authenticate(request, {
    config,
    verifier: config ? sharedTokenVerifier(config) : undefined,
    nodeEnv: process.env.NODE_ENV,
  });
}
