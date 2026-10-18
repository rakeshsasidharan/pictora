import { loadSeedRegistry } from '@pictora/core';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_PROMPTS,
  formatReport,
  percentile,
  ruleFlags,
  runComparison,
} from '../scripts/enhancer_comparison.js';
import type { Enhance } from '../src/enhancer.js';

const registry = loadSeedRegistry();

describe('SAMPLE_PROMPTS', () => {
  it('has 20 prompts, each for a model in the registry', () => {
    expect(SAMPLE_PROMPTS).toHaveLength(20);
    for (const sample of SAMPLE_PROMPTS) {
      expect(registry.some((model) => model.id === sample.modelId)).toBe(true);
    }
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const values = Array.from({ length: 20 }, (_, index) => (index + 1) * 100);
    expect(percentile(values, 50)).toBe(1000);
    expect(percentile(values, 95)).toBe(1900);
    expect(percentile([300, 100, 200], 50)).toBe(200);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('ruleFlags', () => {
  const sample = {
    prompt: 'cozy coffee shop in the rain',
    style: 'cinematic',
    modelId: 'x',
  } as const;

  it('passes a rewrite that keeps the subject and adds no people', () => {
    expect(
      ruleFlags(sample, 'A cozy coffee shop seen through rain-streaked glass, warm amber light'),
    ).toEqual([]);
  });

  it('flags added people, dropped words and the length cap', () => {
    expect(ruleFlags(sample, 'A barista smiling in a coffee shop')).toEqual([
      'adds people',
      'drops cozy, rain',
    ]);
    expect(ruleFlags(sample, `cozy coffee shop in the rain ${'x'.repeat(1500)}`)).toEqual([
      'over 1,500 characters',
    ]);
  });
});

describe('runComparison and formatReport', () => {
  const fast: Enhance = async (input) => ({
    enhancedPrompt: `${input.prompt}, soft light`,
    inputTokens: 100,
    outputTokens: 50,
    costCents: 0.01,
    latencyMs: 800,
  });
  let calls = 0;
  const flaky: Enhance = async (input) => {
    calls += 1;
    if (calls === 1) throw new Error('ThrottlingException');
    return {
      enhancedPrompt: `A person with ${input.prompt}`,
      inputTokens: 100,
      outputTokens: 50,
      costCents: 0.02,
      latencyMs: 2000 + calls,
    };
  };

  it('runs every sample through each candidate and summarises latency, cost and failures', async () => {
    const results = await runComparison(
      [
        { name: 'bedrock:us.openai.gpt-5.6-luna', enhance: fast },
        { name: 'gemini:gemini-3.1-flash-lite', enhance: flaky },
      ],
      registry,
    );
    expect(results[0]).toMatchObject({ p50Ms: 800, p95Ms: 800, failures: 0 });
    expect(results[0]?.totalCostCents).toBeCloseTo(0.2);
    expect(results[1]).toMatchObject({ failures: 1 });
    expect(results[1]?.rewrites[0]).toMatchObject({ ok: false, text: 'ThrottlingException' });
    expect(results[1]?.rewrites[1]?.flags).toContain('adds people');

    const report = formatReport(results, '2026-10-18');
    expect(report).toMatch(/^# Prompt enhancer comparison, 2026-10-18/);
    expect(report).toContain(
      '| `bedrock:us.openai.gpt-5.6-luna` | 0.80 s | 0.80 s | 0.010¢ | 0 | 0 |',
    );
    expect(report).toContain('## 1. a cat on a windowsill');
    expect(report).toContain('## 20. my dog as a superhero');
    expect(report).toContain(
      '| `gemini:gemini-3.1-flash-lite` | ThrottlingException | - | - | failed |  |',
    );
  });
});
