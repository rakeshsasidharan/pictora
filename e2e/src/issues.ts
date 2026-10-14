import type { TestDetails } from '@playwright/test';

const ISSUES_URL = 'https://github.com/rakeshsasidharan/pictora/issues';

/**
 * Links a placeholder test to the issue that will make it pass. Placeholders are marked `test.fixme`, so they
 * are listed in every report without running until that issue lands.
 */
export function landsWith(issue: number): TestDetails {
  return { annotation: { type: 'issue', description: `${ISSUES_URL}/${issue}` } };
}
