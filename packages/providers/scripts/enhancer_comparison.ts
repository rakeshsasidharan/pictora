import { findModel, stylePreset, type ModelConfig, type StyleId } from '@pictora/core';
import { MAX_ENHANCED_PROMPT_LENGTH, type Enhance } from '../src/enhancer.js';

/**
 * The M2 enhancer model test (PRD open question, #20): the same 20 rough prompts go through each candidate,
 * and the report puts the rewrites side by side with rule checks, p50 and p95 latency and cost, so the winner
 * can be recorded in the PRD and set as `ENHANCER_MODEL`.
 */

export interface SamplePrompt {
  prompt: string;
  style: StyleId;
  /** The image model the rewrite is for. */
  modelId: string;
}

/** Short, rough prompts like casual creators type, across styles and target models. */
export const SAMPLE_PROMPTS: readonly SamplePrompt[] = [
  { prompt: 'a cat on a windowsill', style: 'watercolour', modelId: 'gemini-3.1-flash-image' },
  { prompt: 'mountain lake at sunrise', style: 'photorealistic', modelId: 'gemini-3-pro-image' },
  { prompt: 'robot reading a book', style: 'digital-art', modelId: 'gemini-3.1-flash-image' },
  { prompt: 'cozy coffee shop in the rain', style: 'cinematic', modelId: 'gemini-3-pro-image' },
  { prompt: 'a dragon made of clouds', style: 'anime', modelId: 'gemini-3.1-flash-image' },
  { prompt: 'bowl of ramen', style: 'photorealistic', modelId: 'gpt-image-2' },
  { prompt: 'logo for a bakery called Crumbs', style: 'none', modelId: 'gpt-image-2' },
  { prompt: 'old lighthouse', style: 'oil-painting', modelId: 'gemini-3.1-flash-image' },
  { prompt: 'futuristic city at night', style: 'cinematic', modelId: 'gemini-3-pro-image' },
  { prompt: 'fox in the snow', style: 'line-art', modelId: 'gpt-image-2' },
  { prompt: 'sneaker product shot', style: '3d-render', modelId: 'gemini-3.1-flash-image' },
  { prompt: 'birthday card with balloons', style: 'digital-art', modelId: 'gpt-image-1-mini' },
  {
    prompt: 'a tiny house in a forest',
    style: 'watercolour',
    modelId: 'gemini-3.1-flash-lite-image',
  },
  { prompt: 'astronaut cat', style: 'digital-art', modelId: 'gemini-3.1-flash-image' },
  { prompt: 'sunflowers in a vase', style: 'oil-painting', modelId: 'gemini-3.1-flash-image' },
  { prompt: 'poster that says SUMMER SALE', style: 'none', modelId: 'gpt-image-2' },
  { prompt: 'underwater coral reef', style: 'photorealistic', modelId: 'gemini-3-pro-image' },
  { prompt: 'samurai under cherry blossoms', style: 'anime', modelId: 'gemini-3.1-flash-image' },
  { prompt: 'chess pieces on a board', style: '3d-render', modelId: 'gemini-3.1-flash-lite-image' },
  { prompt: 'my dog as a superhero', style: 'digital-art', modelId: 'gpt-image-1-mini' },
];

/** Words that point to added people, which ENH-3 forbids when the prompt had none. */
const PEOPLE_WORDS =
  /\b(person|people|man|men|woman|women|girl|boy|child|children|kid|kids|figure|crowd|couple|family|barista|customer|hiker|pedestrian|silhouette)s?\b/i;

export interface RewriteResult {
  sample: SamplePrompt;
  ok: boolean;
  /** The rewrite, or the error message. */
  text: string;
  latencyMs: number;
  costCents: number;
  /** Rule checks for the reviewer, such as an added person or a missed length cap. */
  flags: string[];
}

export interface CandidateResult {
  candidate: string;
  rewrites: RewriteResult[];
  p50Ms: number;
  p95Ms: number;
  totalCostCents: number;
  failures: number;
}

/** Nearest-rank percentile of the values; 0 for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

/** Rule checks on one rewrite (ENH-3): length cap, an added person, and a lost subject word. */
export function ruleFlags(sample: SamplePrompt, rewrite: string): string[] {
  const flags: string[] = [];
  if (rewrite.length > MAX_ENHANCED_PROMPT_LENGTH) flags.push('over 1,500 characters');
  if (PEOPLE_WORDS.test(rewrite) && !PEOPLE_WORDS.test(sample.prompt)) flags.push('adds people');
  const lower = rewrite.toLowerCase();
  const missing = sample.prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !lower.includes(word));
  if (missing.length > 0) flags.push(`drops ${missing.join(', ')}`);
  return flags;
}

/** Runs every sample through each candidate, one call at a time so latencies don't interfere. Never throws. */
export async function runComparison(
  candidates: readonly { name: string; enhance: Enhance }[],
  models: readonly ModelConfig[],
  samples: readonly SamplePrompt[] = SAMPLE_PROMPTS,
): Promise<CandidateResult[]> {
  const results: CandidateResult[] = [];
  for (const { name, enhance } of candidates) {
    const rewrites: RewriteResult[] = [];
    for (const sample of samples) {
      const model = findModel(models, sample.modelId);
      if (!model) throw new Error(`No model ${sample.modelId} in the registry`);
      try {
        const result = await enhance({
          prompt: sample.prompt,
          styleText: stylePreset(sample.style).styleText,
          model,
        });
        rewrites.push({
          sample,
          ok: true,
          text: result.enhancedPrompt,
          latencyMs: result.latencyMs,
          costCents: result.costCents,
          flags: ruleFlags(sample, result.enhancedPrompt),
        });
      } catch (error) {
        rewrites.push({
          sample,
          ok: false,
          text: error instanceof Error ? error.message : String(error),
          latencyMs: 0,
          costCents: 0,
          flags: ['failed'],
        });
      }
    }
    const latencies = rewrites.filter((rewrite) => rewrite.ok).map((rewrite) => rewrite.latencyMs);
    results.push({
      candidate: name,
      rewrites,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      totalCostCents: rewrites.reduce((sum, rewrite) => sum + rewrite.costCents, 0),
      failures: rewrites.filter((rewrite) => !rewrite.ok).length,
    });
  }
  return results;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

/**
 * A Markdown report: a summary table (p50, p95, cost per call, failures, flagged rewrites), then one table per
 * sample with each candidate's rewrite and flags, and a notes column for the reviewer's quality verdict.
 */
export function formatReport(results: readonly CandidateResult[], date: string): string {
  const lines = [
    `# Prompt enhancer comparison, ${date}`,
    '',
    `${SAMPLE_PROMPTS.length} sample prompts per candidate, one call at a time. Cost is from token usage at the prices in \`ENHANCER_TOKEN_PRICES\`.`,
    '',
    '| Candidate | p50 | p95 | Cost per call | Failures | Flagged rewrites |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of results) {
    const calls = result.rewrites.length - result.failures;
    const perCall = calls > 0 ? result.totalCostCents / calls : 0;
    const flagged = result.rewrites.filter((rewrite) => rewrite.ok && rewrite.flags.length > 0);
    lines.push(
      `| \`${result.candidate}\` | ${(result.p50Ms / 1000).toFixed(2)} s | ${(result.p95Ms / 1000).toFixed(2)} s | ${perCall.toFixed(3)}¢ | ${result.failures} | ${flagged.length} |`,
    );
  }
  const samples = results[0]?.rewrites.map((rewrite) => rewrite.sample) ?? [];
  samples.forEach((sample, index) => {
    lines.push(
      '',
      `## ${index + 1}. ${sample.prompt}`,
      '',
      `Style: ${sample.style}. Model: ${sample.modelId}.`,
      '',
      '| Candidate | Rewrite | Length | Latency | Flags | Notes |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const result of results) {
      const rewrite = result.rewrites[index];
      if (!rewrite) continue;
      lines.push(
        `| \`${result.candidate}\` | ${cell(rewrite.text)} | ${rewrite.ok ? rewrite.text.length : '-'} | ${rewrite.ok ? `${(rewrite.latencyMs / 1000).toFixed(2)} s` : '-'} | ${cell(rewrite.flags.join('; ')) || 'none'} |  |`,
      );
    }
  });
  return `${lines.join('\n')}\n`;
}
