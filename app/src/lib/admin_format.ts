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
 * Chart colours by provider, from the theme's chart tokens (`--chart-1` to `--chart-4`, with light and dark
 * values), in a fixed order so a provider keeps its colour whatever else is shown. Some slots sit below 3:1
 * against the background, so the chart always has a table of the same numbers under it. Whole class names, so
 * Tailwind finds them: `fill` for the bars, `swatch` for the legend.
 */
export const PROVIDER_COLOURS: Record<string, ProviderColour> = {
  openai: { fill: 'fill-chart-1', swatch: 'bg-chart-1' },
  gemini: { fill: 'fill-chart-2', swatch: 'bg-chart-2' },
  bedrock: { fill: 'fill-chart-3', swatch: 'bg-chart-3' },
  mock: { fill: 'fill-chart-4', swatch: 'bg-chart-4' },
};

/** Any other provider, such as `unknown`. */
export const OTHER_PROVIDER_COLOUR: ProviderColour = {
  fill: 'fill-muted-foreground',
  swatch: 'bg-muted-foreground',
};

export interface ProviderColour {
  fill: string;
  swatch: string;
}

export function providerColour(provider: string): ProviderColour {
  return PROVIDER_COLOURS[provider] ?? OTHER_PROVIDER_COLOUR;
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Where the CLI-only admin tasks are documented (ADM-2 kill switches, ADM-5 point overrides): the README
 * on GitHub.
 */
export const ADMIN_RUNBOOK_URL = 'https://github.com/rakeshsasidharan/pictora#operations';
