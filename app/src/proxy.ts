import { NextResponse, type NextRequest } from 'next/server';
import { expectedOriginSecret, ORIGIN_VERIFY_HEADER, verifyOrigin } from './lib/origin_verify';

/**
 * Rejects requests that didn't come through CloudFront (tech design 3.1). The Function URL is public, so
 * without this check anyone could call the app directly and bypass the CDN.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const result = await verifyOrigin(request.headers.get(ORIGIN_VERIFY_HEADER), {
    nodeEnv: process.env.NODE_ENV,
    expectedValue: () => expectedOriginSecret(),
  });
  if (result === 'forbidden') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return NextResponse.next();
}
