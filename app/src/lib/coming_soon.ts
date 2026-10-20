const ISSUES_URL = 'https://github.com/rakeshsasidharan/pictora/issues';

/** A sub-feature that isn't built yet, and the issue that builds it. */
export interface ComingSoonFeature {
  name: string;
  issue: number;
}

/** Features the generate and edit screens link to before they land (gallery #23). */
export const COMING_SOON = {
  gallery: { name: 'Gallery', issue: 23 },
} as const satisfies Record<string, ComingSoonFeature>;

export function issueUrl(issue: number): string {
  return `${ISSUES_URL}/${issue}`;
}
