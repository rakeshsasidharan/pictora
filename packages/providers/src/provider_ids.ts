/** Image providers behind the adapter interface. Bedrock arrives in P1; mock is dev only. */
export const PROVIDER_IDS = ['openai', 'gemini', 'bedrock', 'mock'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
