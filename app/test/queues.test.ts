import { describe, expect, it } from 'vitest';
import { queueUrl, queueUrlVariable } from '../src/lib/queues';

const env = {
  OPENAI_QUEUE_URL: 'https://sqs.example/pictora-dev-openai',
  GEMINI_QUEUE_URL: 'https://sqs.example/pictora-dev-gemini',
} as unknown as NodeJS.ProcessEnv;

describe('queueUrl', () => {
  it('names the variable after the provider, as the Web stack sets it', () => {
    expect(queueUrlVariable('openai')).toBe('OPENAI_QUEUE_URL');
    expect(queueUrlVariable('bedrock')).toBe('BEDROCK_QUEUE_URL');
  });

  it("returns each provider's queue", () => {
    expect(queueUrl('openai', env)).toBe(env.OPENAI_QUEUE_URL);
    expect(queueUrl('gemini', env)).toBe(env.GEMINI_QUEUE_URL);
  });

  it('sends mock jobs through the OpenAI queue', () => {
    expect(queueUrl('mock', env)).toBe(env.OPENAI_QUEUE_URL);
  });

  it("returns the Bedrock queue, and nothing when a provider's URL isn't set", () => {
    expect(
      queueUrl('bedrock', {
        BEDROCK_QUEUE_URL: 'https://sqs.example/pictora-dev-bedrock',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe('https://sqs.example/pictora-dev-bedrock');
    expect(queueUrl('bedrock', env)).toBeUndefined();
    expect(queueUrl('openai', {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
