export const dynamic = 'force-dynamic';

/** Liveness check used by the Lambda Web Adapter and the prod smoke test. */
export function GET(): Response {
  return Response.json({ status: 'ok', sha: process.env.GIT_SHA || 'local' });
}
