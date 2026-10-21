import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ModelConfig } from '@pictora/core';
import { ProviderError, toProviderError } from './errors.js';
import { providerSignal } from './retry.js';

/** The enhancer's output is capped at 1,500 characters (ENH-3). */
export const MAX_ENHANCED_PROMPT_LENGTH = 1500;

/** One enhancer call gets 10 s; the target is under 3 s (tech design 6.3). */
export const ENHANCER_TIMEOUT_MS = 10_000;

/** Enough output tokens for 1,500 characters with room to spare. */
export const ENHANCER_MAX_OUTPUT_TOKENS = 600;

/** The Bedrock enhancer models run in us-west-2, like the image models. */
export const ENHANCER_BEDROCK_REGION = 'us-west-2';

export const GEMINI_TEXT_API_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Where the enhancer runs: `bedrock:<model or inference profile ID>`, `gemini:<model ID>` or `mock`. */
export type EnhancerModel =
  | { backend: 'bedrock'; modelId: string }
  | { backend: 'gemini'; modelId: string }
  | { backend: 'mock'; modelId: 'mock' };

/** US dollars per million tokens, keyed by the model ID after the backend prefix. */
export interface EnhancerTokenPrices {
  input: number;
  output: number;
}

export const ENHANCER_TOKEN_PRICES: Readonly<Record<string, EnhancerTokenPrices>> = {
  'us.openai.gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'openai.gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
};

/** The two candidates the M2 test compares (PRD open question). */
export const ENHANCER_CANDIDATES = [
  'bedrock:us.openai.gpt-5.6-luna',
  'gemini:gemini-3.1-flash-lite',
];

/** Parses `ENHANCER_MODEL`. Throws on anything but `bedrock:<id>`, `gemini:<id>` or `mock`. */
export function parseEnhancerModel(value: string | undefined): EnhancerModel {
  const text = value?.trim() ?? '';
  if (text === 'mock') return { backend: 'mock', modelId: 'mock' };
  const match = /^(bedrock|gemini):([A-Za-z0-9._:-]+)$/.exec(text);
  if (!match?.[1] || !match[2]) {
    throw new Error(
      `ENHANCER_MODEL must be bedrock:<model ID>, gemini:<model ID> or mock: ${text || '(unset)'}`,
    );
  }
  return { backend: match[1] as 'bedrock' | 'gemini', modelId: match[2] };
}

/** `bedrock:<id>`, `gemini:<id>` or `mock`, as written in config and stats. */
export function enhancerModelName(model: EnhancerModel): string {
  return model.backend === 'mock' ? 'mock' : `${model.backend}:${model.modelId}`;
}

/** The rules the enhancer follows (ENH-1, ENH-3). */
export const ENHANCER_SYSTEM_PROMPT = [
  'You rewrite rough image prompts into detailed prompts for an image generation model.',
  'Rules:',
  "- Keep the user's intent and every subject, object and detail they asked for.",
  '- Add detail about the subject, composition, camera or viewpoint, lighting, colour and style, suited to the target model and style.',
  '- Never add people, characters, brands, logos, trademarks, text, words or any content the user did not ask for.',
  '- Never make the prompt more violent, sexual or graphic than the user wrote it.',
  `- Write at most ${MAX_ENHANCED_PROMPT_LENGTH} characters, in the language of the user's prompt.`,
  '- Return only the rewritten prompt: no title, quotes, notes, explanations or lists.',
].join('\n');

export interface EnhanceInput {
  /** The user's words. */
  prompt: string;
  /** The style preset's text, when a preset is chosen (`styleText` in core). */
  styleText?: string;
  /** The image model the prompt is for. */
  model: Pick<ModelConfig, 'displayName' | 'strengths'>;
}

/** The user message: the target model and its strengths, the style, then the prompt to rewrite. */
export function enhancerUserMessage(input: EnhanceInput): string {
  const lines = [
    `Target image model: ${input.model.displayName} (strengths: ${input.model.strengths.join(', ')}).`,
  ];
  // The style text is added to the final prompt anyway, so the enhancer only uses it as a guide.
  if (input.styleText)
    lines.push(`Style (added separately; do not repeat it): ${input.styleText}.`);
  lines.push('Prompt to rewrite:', input.prompt.trim());
  return lines.join('\n');
}

export interface EnhanceResult {
  enhancedPrompt: string;
  inputTokens: number;
  outputTokens: number;
  /** From the token usage at `ENHANCER_TOKEN_PRICES`; 0 for the mock or a model with no prices. */
  costCents: number;
  latencyMs: number;
}

export type Enhance = (
  input: EnhanceInput,
  options?: { signal?: AbortSignal },
) => Promise<EnhanceResult>;

export interface EnhancerOptions {
  model: EnhancerModel;
  /** The Gemini API key, read from Secrets Manager `pictora/<env>/gemini`; needed for `gemini:` models. */
  geminiApiKey?: () => Promise<string>;
  bedrock?: Pick<BedrockRuntimeClient, 'send'>;
  geminiUrl?: string;
  timeoutMs?: number;
  prices?: Readonly<Record<string, EnhancerTokenPrices>>;
  now?: () => number;
}

interface RawCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The prompt enhancer client (tech design 6.3). One call per enhancement, with no retry: the request is
 * synchronous and the caller falls back to the user's words when it fails.
 */
export function createEnhancer(options: EnhancerOptions): Enhance {
  const { model, timeoutMs = ENHANCER_TIMEOUT_MS, now = Date.now } = options;
  const prices = options.prices ?? ENHANCER_TOKEN_PRICES;
  let bedrock = options.bedrock;

  const complete = async (input: EnhanceInput, signal: AbortSignal): Promise<RawCompletion> => {
    switch (model.backend) {
      case 'mock':
        return mockCompletion(input);
      case 'bedrock':
        bedrock ??= new BedrockRuntimeClient({ region: ENHANCER_BEDROCK_REGION });
        return bedrockCompletion(bedrock, model.modelId, input, signal);
      case 'gemini': {
        if (!options.geminiApiKey) throw new ProviderError('The Gemini enhancer needs an API key');
        let apiKey: string;
        try {
          apiKey = await options.geminiApiKey();
        } catch (error) {
          throw new ProviderError('The Gemini API key could not be read', { cause: error });
        }
        return geminiCompletion(
          options.geminiUrl ?? GEMINI_TEXT_API_URL,
          apiKey,
          model.modelId,
          input,
          signal,
        );
      }
    }
  };

  return async (input, { signal } = {}) => {
    const started = now();
    let raw: RawCompletion;
    try {
      raw = await complete(input, providerSignal(signal, timeoutMs));
    } catch (error) {
      throw toProviderError(error);
    }
    return {
      enhancedPrompt: parseEnhancement(raw.text),
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      costCents: enhancerCostCents(model, raw.inputTokens, raw.outputTokens, prices),
      latencyMs: now() - started,
    };
  };
}

/**
 * Cleans the model's answer into a prompt: drops code fences, a leading label such as `Prompt:`, and wrapping
 * quotes, joins it onto one paragraph, and cuts it to 1,500 characters at a word boundary. Throws when nothing
 * is left.
 */
export function parseEnhancement(text: string): string {
  let prompt = text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
    .replace(/^(?:enhanced |rewritten |improved )?prompt\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const quotes = /^(["'“‘])([\s\S]*)(["'”’])$/.exec(prompt);
  if (quotes?.[2] !== undefined) prompt = quotes[2].trim();
  if (!prompt) throw new ProviderError('The enhancer returned an empty prompt');
  return capLength(prompt, MAX_ENHANCED_PROMPT_LENGTH);
}

/** Cuts text to `max` characters, at the last word boundary when there is one in the final fifth. */
function capLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const trimmed = space >= max * 0.8 ? cut.slice(0, space) : cut;
  return trimmed.replace(/[\s,;:–-]+$/, '');
}

/** The cost of one call in cents, to hundredths of a cent. */
export function enhancerCostCents(
  model: EnhancerModel,
  inputTokens: number,
  outputTokens: number,
  prices: Readonly<Record<string, EnhancerTokenPrices>> = ENHANCER_TOKEN_PRICES,
): number {
  const price = model.backend === 'mock' ? undefined : prices[model.modelId];
  if (!price) return 0;
  const dollars = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return Math.round(dollars * 100 * 100) / 100;
}

/** A fixed rewrite for dev and tests: the prompt with generic detail added. */
function mockCompletion(input: EnhanceInput): RawCompletion {
  const text = `${input.prompt.trim()}, detailed composition, balanced framing, soft natural lighting, rich colour`;
  return { text, inputTokens: 0, outputTokens: 0 };
}

async function bedrockCompletion(
  client: Pick<BedrockRuntimeClient, 'send'>,
  modelId: string,
  input: EnhanceInput,
  signal: AbortSignal,
): Promise<RawCompletion> {
  const response = await client.send(
    new ConverseCommand({
      modelId,
      system: [{ text: ENHANCER_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: enhancerUserMessage(input) }] }],
      inferenceConfig: { maxTokens: ENHANCER_MAX_OUTPUT_TOKENS },
    }),
    { abortSignal: signal },
  );
  const text = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  if (!text) {
    throw new ProviderError(
      `The enhancer returned no text (${response.stopReason ?? 'no reason'})`,
    );
  }
  return {
    text,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
  };
}

interface GeminiTextResponse {
  candidates?: {
    content?: { parts?: { text?: unknown; thought?: unknown }[] };
    finishReason?: unknown;
  }[];
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    thoughtsTokenCount?: unknown;
  };
}

async function geminiCompletion(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  input: EnhanceInput,
  signal: AbortSignal,
): Promise<RawCompletion> {
  const response = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: ENHANCER_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: enhancerUserMessage(input) }] }],
      generationConfig: { maxOutputTokens: ENHANCER_MAX_OUTPUT_TOKENS },
    }),
    signal,
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Gemini enhancer request failed with HTTP ${response.status}`), {
      status: response.status,
    });
  }
  const body = (await response.json()) as GeminiTextResponse;
  const blockReason = body.promptFeedback?.blockReason;
  if (typeof blockReason === 'string') {
    throw new ProviderError(`Gemini blocked the enhancer prompt: ${blockReason}`);
  }
  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim();
  if (!text) {
    const reason =
      typeof candidate?.finishReason === 'string' ? candidate.finishReason : 'no reason';
    throw new ProviderError(`The enhancer returned no text (${reason})`);
  }
  const usage = body.usageMetadata ?? {};
  const count = (value: unknown) => (typeof value === 'number' ? value : 0);
  return {
    text,
    inputTokens: count(usage.promptTokenCount),
    // Thinking tokens are billed as output.
    outputTokens: count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount),
  };
}
