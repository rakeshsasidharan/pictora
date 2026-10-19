import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ENHANCER_MAX_OUTPUT_TOKENS,
  ENHANCER_SYSTEM_PROMPT,
  MAX_ENHANCED_PROMPT_LENGTH,
  createEnhancer,
  enhancerCostCents,
  enhancerModelName,
  enhancerUserMessage,
  parseEnhancement,
  parseEnhancerModel,
  type EnhanceInput,
} from '../src/enhancer.js';
import { ProviderError, ProviderRateLimitError, ProviderTimeoutError } from '../src/errors.js';

const GEMINI_URL = 'https://gemini.test/v1beta';
const GEMINI_ENDPOINT = `${GEMINI_URL}/models/gemini-3.1-flash-lite:generateContent`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const input: EnhanceInput = {
  prompt: '  a cat on a windowsill ',
  styleText: 'watercolour painting, soft washes',
  model: { displayName: 'GPT Image 2', strengths: ['Follows prompts closely', 'Precise edits'] },
};

const ENHANCED =
  'A ginger cat curled up asleep on a sunlit wooden windowsill, soft morning light through sheer curtains, shallow depth of field, warm muted palette';

describe('parseEnhancerModel', () => {
  it('reads bedrock:, gemini: and mock', () => {
    expect(parseEnhancerModel('bedrock:us.openai.gpt-5.6-luna')).toEqual({
      backend: 'bedrock',
      modelId: 'us.openai.gpt-5.6-luna',
    });
    expect(parseEnhancerModel(' gemini:gemini-3.1-flash-lite ')).toEqual({
      backend: 'gemini',
      modelId: 'gemini-3.1-flash-lite',
    });
    expect(parseEnhancerModel('mock')).toEqual({ backend: 'mock', modelId: 'mock' });
  });

  it.each([undefined, '', 'openai:gpt-5', 'bedrock:', 'gemini:a b'])('rejects %s', (value) => {
    expect(() => parseEnhancerModel(value)).toThrow(/ENHANCER_MODEL must be/);
  });

  it('names the model as written in config', () => {
    expect(enhancerModelName(parseEnhancerModel('bedrock:us.openai.gpt-5.6-luna'))).toBe(
      'bedrock:us.openai.gpt-5.6-luna',
    );
    expect(enhancerModelName(parseEnhancerModel('mock'))).toBe('mock');
  });
});

describe('the enhancer prompt', () => {
  it('states the ENH-3 rules', () => {
    expect(ENHANCER_SYSTEM_PROMPT).toMatch(/Keep the user's intent/);
    expect(ENHANCER_SYSTEM_PROMPT).toMatch(/subject, composition/);
    expect(ENHANCER_SYSTEM_PROMPT).toMatch(/lighting/);
    expect(ENHANCER_SYSTEM_PROMPT).toMatch(/Never add people, characters, brands, logos/);
    expect(ENHANCER_SYSTEM_PROMPT).toMatch(/at most 1500 characters/);
    expect(ENHANCER_SYSTEM_PROMPT).toMatch(/Return only the rewritten prompt/);
  });

  it('names the target model, its strengths and the style, then the trimmed prompt', () => {
    expect(enhancerUserMessage(input)).toBe(
      [
        'Target image model: GPT Image 2 (strengths: Follows prompts closely, Precise edits).',
        'Style (added separately; do not repeat it): watercolour painting, soft washes.',
        'Prompt to rewrite:',
        'a cat on a windowsill',
      ].join('\n'),
    );
    expect(enhancerUserMessage({ ...input, styleText: '' })).not.toMatch(/Style/);
  });
});

describe('parseEnhancement', () => {
  it('returns a clean answer as is', () => {
    expect(parseEnhancement(ENHANCED)).toBe(ENHANCED);
  });

  it('drops labels, quotes, code fences and line breaks', () => {
    expect(parseEnhancement(`Prompt: "${ENHANCED}"`)).toBe(ENHANCED);
    expect(parseEnhancement(`Enhanced prompt:\n\n${ENHANCED}`)).toBe(ENHANCED);
    expect(parseEnhancement(`\`\`\`text\n${ENHANCED}\n\`\`\``)).toBe(ENHANCED);
    expect(parseEnhancement(`“${ENHANCED}”`)).toBe(ENHANCED);
    expect(parseEnhancement('A cat,\n  asleep\n\non a sill')).toBe('A cat, asleep on a sill');
  });

  it('caps the prompt at 1,500 characters on a word boundary', () => {
    const long = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');
    const capped = parseEnhancement(long);
    expect(capped.length).toBeLessThanOrEqual(MAX_ENHANCED_PROMPT_LENGTH);
    expect(long.startsWith(capped)).toBe(true);
    expect(long[capped.length]).toBe(' ');
  });

  it('cuts a prompt with no spaces at exactly 1,500 characters', () => {
    expect(parseEnhancement('x'.repeat(2000))).toHaveLength(MAX_ENHANCED_PROMPT_LENGTH);
  });

  it('rejects an empty answer', () => {
    expect(() => parseEnhancement('  "" ')).toThrow('The enhancer returned an empty prompt');
    expect(() => parseEnhancement('Prompt:')).toThrow(ProviderError);
  });
});

describe('enhancerCostCents', () => {
  it('prices input and output tokens at the model rate', () => {
    // 400 input tokens at $0.20/M and 150 output tokens at $1.20/M = $0.00026.
    expect(enhancerCostCents(parseEnhancerModel('bedrock:us.openai.gpt-5.6-luna'), 400, 150)).toBe(
      0.03,
    );
    // 10,000 input tokens at $0.25/M and 5,000 output tokens at $1.50/M = $0.01.
    expect(
      enhancerCostCents(parseEnhancerModel('gemini:gemini-3.1-flash-lite'), 10_000, 5_000),
    ).toBe(1);
  });

  it('is 0 for the mock and for a model with no prices', () => {
    expect(enhancerCostCents(parseEnhancerModel('mock'), 100, 100)).toBe(0);
    expect(enhancerCostCents(parseEnhancerModel('gemini:unknown'), 100, 100)).toBe(0);
  });
});

describe('createEnhancer with Bedrock', () => {
  it('calls Converse with the system prompt, the user message and an output cap', async () => {
    const bedrock = mockClient(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: `  ${ENHANCED}\n` }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 400, outputTokens: 150, totalTokens: 550 },
      metrics: { latencyMs: 900 },
    });
    let time = 0;
    const enhance = createEnhancer({
      model: parseEnhancerModel('bedrock:us.openai.gpt-5.6-luna'),
      bedrock: new BedrockRuntimeClient({ region: 'us-west-2' }),
      now: () => (time += 1200),
    });

    const result = await enhance(input);

    expect(result).toEqual({
      enhancedPrompt: ENHANCED,
      inputTokens: 400,
      outputTokens: 150,
      costCents: 0.03,
      latencyMs: 1200,
    });
    const [call] = bedrock.commandCalls(ConverseCommand);
    expect(call?.args[0].input).toEqual({
      modelId: 'us.openai.gpt-5.6-luna',
      system: [{ text: ENHANCER_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: enhancerUserMessage(input) }] }],
      inferenceConfig: { maxTokens: ENHANCER_MAX_OUTPUT_TOKENS },
    });
    bedrock.restore();
  });

  it('maps throttling to ProviderRateLimitError and an empty answer to ProviderError', async () => {
    const bedrock = mockClient(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).rejects(
      Object.assign(new Error('Too many requests'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 429 },
      }),
    );
    const enhance = createEnhancer({
      model: parseEnhancerModel('bedrock:us.openai.gpt-5.6-luna'),
      bedrock: new BedrockRuntimeClient({ region: 'us-west-2' }),
    });
    await expect(enhance(input)).rejects.toBeInstanceOf(ProviderRateLimitError);

    bedrock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [] } },
      stopReason: 'max_tokens',
    });
    await expect(enhance(input)).rejects.toThrow('The enhancer returned no text (max_tokens)');
    bedrock.restore();
  });
});

describe('createEnhancer with Gemini', () => {
  function gemini(apiKey = async () => 'g-key') {
    return createEnhancer({
      model: parseEnhancerModel('gemini:gemini-3.1-flash-lite'),
      geminiApiKey: apiKey,
      geminiUrl: GEMINI_URL,
    });
  }

  it('calls generateContent with the system instruction, and skips thought parts', async () => {
    let seen: { key: string | null; body: unknown } | undefined;
    server.use(
      http.post(GEMINI_ENDPOINT, async ({ request }) => {
        seen = { key: request.headers.get('x-goog-api-key'), body: await request.json() };
        return HttpResponse.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'thinking about cats', thought: true }, { text: ENHANCED }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10_000,
            candidatesTokenCount: 4_000,
            thoughtsTokenCount: 1_000,
          },
        });
      }),
    );

    const result = await gemini()(input);

    expect(result).toMatchObject({
      enhancedPrompt: ENHANCED,
      inputTokens: 10_000,
      outputTokens: 5_000,
      costCents: 1,
    });
    expect(seen?.key).toBe('g-key');
    expect(seen?.body).toEqual({
      systemInstruction: { parts: [{ text: ENHANCER_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: enhancerUserMessage(input) }] }],
      generationConfig: { maxOutputTokens: ENHANCER_MAX_OUTPUT_TOKENS },
    });
  });

  it('maps HTTP errors, a blocked prompt and an empty answer to typed errors', async () => {
    server.use(http.post(GEMINI_ENDPOINT, () => new HttpResponse(null, { status: 429 })));
    await expect(gemini()(input)).rejects.toBeInstanceOf(ProviderRateLimitError);

    server.use(http.post(GEMINI_ENDPOINT, () => new HttpResponse(null, { status: 500 })));
    await expect(gemini()(input)).rejects.toMatchObject({ status: 500, retryable: true });

    server.use(
      http.post(GEMINI_ENDPOINT, () =>
        HttpResponse.json({ promptFeedback: { blockReason: 'SAFETY' } }),
      ),
    );
    await expect(gemini()(input)).rejects.toThrow('Gemini blocked the enhancer prompt: SAFETY');

    server.use(
      http.post(GEMINI_ENDPOINT, () =>
        HttpResponse.json({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }),
      ),
    );
    await expect(gemini()(input)).rejects.toThrow('The enhancer returned no text (MAX_TOKENS)');
  });

  it('needs a key that can be read', async () => {
    await expect(
      createEnhancer({ model: parseEnhancerModel('gemini:gemini-3.1-flash-lite') })(input),
    ).rejects.toThrow('The Gemini enhancer needs an API key');
    await expect(gemini(() => Promise.reject(new Error('AccessDenied')))(input)).rejects.toThrow(
      'The Gemini API key could not be read',
    );
  });

  it('gives up with ProviderTimeoutError after its timeout', async () => {
    server.use(
      http.post(GEMINI_ENDPOINT, async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return HttpResponse.json({});
      }),
    );
    const slow = createEnhancer({
      model: parseEnhancerModel('gemini:gemini-3.1-flash-lite'),
      geminiApiKey: async () => 'g-key',
      geminiUrl: GEMINI_URL,
      timeoutMs: 20,
    });
    await expect(slow(input)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});

describe('createEnhancer with the mock', () => {
  it('adds fixed detail to the prompt at no cost', async () => {
    const result = await createEnhancer({ model: parseEnhancerModel('mock') })(input);
    expect(result).toMatchObject({
      enhancedPrompt:
        'a cat on a windowsill, detailed composition, balanced framing, soft natural lighting, rich colour',
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    });
  });
});
