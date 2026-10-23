import { NextResponse, type NextRequest } from 'next/server';
import { authConfig } from './lib/auth_config';
import { authenticate } from './lib/auth_proxy';
import { expectedOriginSecret, ORIGIN_VERIFY_HEADER, verifyOrigin } from './lib/origin_verify';
import {
  contentSecurityPolicy,
  createNonce,
  CSP_HEADER,
  imagesBucketOrigin,
  NONCE_HEADER,
  setSecurityHeaders,
} from './lib/security_headers';
import { sharedTokenVerifier } from './lib/token_verifier';

/**
 * Rejects requests that didn't come through CloudFront (tech design 3.1): the Function URL is public, so
 * without this check anyone could call the app directly and bypass the CDN. Then checks CSRF and the session
 * (tech design 8). Every response carries the security headers (tech design 12), with a fresh script nonce.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = createNonce();
  const csp = contentSecurityPolicy({
    nonce,
    imagesOrigin: imagesBucketOrigin(process.env),
    cognitoDomain: process.env.COGNITO_DOMAIN?.replace(/\/+$/, ''),
    development: process.env.NODE_ENV === 'development',
  });
  const response = await handle(request, { [CSP_HEADER]: csp, [NONCE_HEADER]: nonce });
  setSecurityHeaders(response.headers, { csp, hsts: process.env.PICTORA_ENV === 'prod' });
  return response;
}

async function handle(
  request: NextRequest,
  requestHeaders: Record<string, string>,
): Promise<NextResponse> {
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
    requestHeaders,
  });
}
