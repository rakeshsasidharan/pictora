/** Site under test: the dev stack URL in CI, or a local dev server. */
export function baseUrl(): string {
  return process.env.E2E_BASE_URL || 'http://localhost:3000';
}
