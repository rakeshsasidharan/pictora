import type { NextRequest } from 'next/server';
import { handleCallback } from '../../../lib/auth_callback';
import { authConfig } from '../../../lib/auth_config';
import { sharedTokenVerifier } from '../../../lib/token_verifier';

export const dynamic = 'force-dynamic';

/** Cognito's redirect after sign-in (tech design 8). */
export async function GET(request: NextRequest): Promise<Response> {
  const config = await authConfig();
  return handleCallback(request, {
    config,
    verifier: config ? sharedTokenVerifier(config) : undefined,
  });
}
