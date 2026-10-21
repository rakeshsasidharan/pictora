/** Cents as dollars, for example `$12.34`. */
export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** A share as a percentage with one decimal, for example `4.2%`. */
export function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** Provider names as the dashboard shows them. */
export const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  bedrock: 'Bedrock',
  mock: 'Mock',
  unknown: 'Unknown',
};

/**
 * Chart colours by provider, in a fixed order so a provider keeps its colour whatever else is shown. These are
 * the first four slots of the validated categorical palette; yellow and aqua sit below 3:1 on white, so the chart
 * always has a table of the same numbers under it.
 */
export const PROVIDER_COLOURS: Record<string, string> = {
  openai: '#2a78d6',
  gemini: '#eb6834',
  bedrock: '#1baf7a',
  mock: '#eda100',
  unknown: '#55535e',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Where the CLI-only admin tasks are documented (ADM-2 kill switches, ADM-5 point overrides): the README
 * on GitHub.
 */
export const ADMIN_RUNBOOK_URL = 'https://github.com/rakeshsasidharan/pictora#operations';
