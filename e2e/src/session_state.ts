import { fileURLToPath } from 'node:url';

/**
 * Where the setup project saves the signed-in browser state for the tests to reuse. It holds session cookies,
 * so it lives outside `test-results` and `playwright-report` (which CI uploads) and is ignored by git.
 */
export const SESSION_STATE_PATH = fileURLToPath(new URL('../.auth/user.json', import.meta.url));
