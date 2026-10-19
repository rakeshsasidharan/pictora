/**
 * The text-only clients, for the web app: the prompt enhancer, moderation and secrets. Unlike the package root,
 * nothing here loads `sharp`.
 */
export {
  ENHANCER_BEDROCK_REGION,
  ENHANCER_CANDIDATES,
  ENHANCER_MAX_OUTPUT_TOKENS,
  ENHANCER_SYSTEM_PROMPT,
  ENHANCER_TIMEOUT_MS,
  ENHANCER_TOKEN_PRICES,
  GEMINI_TEXT_API_URL,
  MAX_ENHANCED_PROMPT_LENGTH,
  createEnhancer,
  enhancerCostCents,
  enhancerModelName,
  enhancerUserMessage,
  parseEnhancement,
  parseEnhancerModel,
} from './enhancer.js';
export type {
  Enhance,
  EnhanceInput,
  EnhanceResult,
  EnhancerModel,
  EnhancerOptions,
  EnhancerTokenPrices,
} from './enhancer.js';
export {
  ProviderError,
  ProviderRateLimitError,
  ProviderSafetyError,
  ProviderTimeoutError,
} from './errors.js';
export { createModerator } from './moderation.js';
export type { Moderate, ModerationInput, ModeratorOptions } from './moderation.js';
export { secretApiKey } from './secrets.js';
