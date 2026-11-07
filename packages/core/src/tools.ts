import { TESTERS_GROUP } from './admin.js';
import type { ModelConfig, Provider } from './registry.js';
import type { Size } from './size_mapping.js';

/**
 * One-click image tools (PRD scope, P1 Image tools; tech design 5.5): each makes a new version of an image from
 * one of its versions, through a Stability edit model on Bedrock.
 */
export const IMAGE_TOOLS = ['upscale', 'remove-background', 'erase', 'outpaint'] as const;
export type ImageTool = (typeof IMAGE_TOOLS)[number];

/** How an upscale is made: Stability's fast, conservative or creative upscaler. */
export const UPSCALE_MODES = ['fast', 'conservative', 'creative'] as const;
export type UpscaleMode = (typeof UPSCALE_MODES)[number];

/**
 * A tool as the registry prices it: a tool, with the upscale's mode. Each one is a different Stability model,
 * with its own price.
 */
export const TOOL_IDS = [
  'upscale-fast',
  'upscale-conservative',
  'upscale-creative',
  'remove-background',
  'erase',
  'outpaint',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** Providers whose adapters run image tools: Bedrock (Stability), and the Mock on dev. */
export const TOOL_PROVIDERS: readonly Provider[] = ['bedrock', 'mock'];

/** What the UI calls each tool. */
export const TOOL_NAMES: Readonly<Record<ToolId, string>> = {
  'upscale-fast': 'Fast upscale',
  'upscale-conservative': 'Conservative upscale',
  'upscale-creative': 'Creative upscale',
  'remove-background': 'Remove background',
  erase: 'Erase object',
  outpaint: 'Outpaint',
};

/** The tool behind each tool id. */
export const TOOL_OF: Readonly<Record<ToolId, ImageTool>> = {
  'upscale-fast': 'upscale',
  'upscale-conservative': 'upscale',
  'upscale-creative': 'upscale',
  'remove-background': 'remove-background',
  erase: 'erase',
  outpaint: 'outpaint',
};

/** Most pixels an outpaint adds on one side (Stability's limit). */
export const MAX_OUTPAINT_PIXELS = 2000;

/** Most characters of an upscale or outpaint prompt; the same limit as a generate prompt (GEN-1). */
export const MAX_TOOL_PROMPT_LENGTH = 2000;

/** How far an erase mask is grown at its edges by default, in pixels (Stability's `grow_mask`, 0 to 20). */
export const DEFAULT_GROW_MASK = 5;
export const MAX_GROW_MASK = 20;

/** The tool id of an upscale mode. */
export function upscaleToolId(mode: UpscaleMode): ToolId {
  return `upscale-${mode}`;
}

/** The tool id a tool request runs: the tool, or for an upscale, its mode. */
export function toolIdFor(request: { tool: ImageTool; params: object }): ToolId {
  if (request.tool === 'upscale') {
    const { mode } = request.params as { mode: UpscaleMode };
    return upscaleToolId(mode);
  }
  return request.tool;
}

/** True for a tool that takes a prompt, which Stability requires for the conservative and creative upscales. */
export function toolTakesPrompt(toolId: ToolId): boolean {
  return (
    toolId === 'upscale-conservative' || toolId === 'upscale-creative' || toolId === 'outpaint'
  );
}

/** Points one run of the tool costs on this model, or undefined when the model doesn't run it. */
export function toolCostPoints(
  model: Pick<ModelConfig, 'tools'>,
  toolId: ToolId,
): number | undefined {
  return model.tools?.[toolId]?.costPoints;
}

/** True for a model that only runs tools, so the generate and edit screens never offer it. */
export function isToolOnlyModel(model: Pick<ModelConfig, 'capabilities'>): boolean {
  return !model.capabilities.generate && !model.capabilities.edit;
}

/**
 * The model that runs a tool for a user: the first in registry order that runs it. The `testers` group (the
 * e2e test account) gets the Mock model first where it runs the tool, so end-to-end runs cost nothing; everyone
 * else never sees the Mock (`modelsForGroups`). `models` should already be the enabled, queued models the user
 * may use.
 */
export function pickToolModel<T extends Pick<ModelConfig, 'provider' | 'tools'>>(
  models: readonly T[],
  toolId: ToolId,
  groups: readonly string[],
): T | undefined {
  const running = models.filter((model) => toolCostPoints(model, toolId) !== undefined);
  if (groups.includes(TESTERS_GROUP)) {
    const mock = running.find((model) => model.provider === 'mock');
    if (mock) return mock;
  }
  return running.find((model) => model.provider !== 'mock') ?? running[0];
}

/** Size limits of a tool's input image (Stability Image Services on Bedrock). */
export interface ToolInputLimits {
  /** Shortest side allowed. */
  minSide: number;
  /** Longest side allowed, when the model has one. */
  maxSide?: number;
  minPixels?: number;
  maxPixels: number;
  /** Widest width-to-height (or height-to-width) ratio allowed, when the model has one. */
  maxAspect?: number;
}

/** Limits from the Stability Image Services doc, checked on 2026-11-06 (#35). */
export const TOOL_INPUT_LIMITS: Readonly<Record<ToolId, ToolInputLimits>> = {
  'upscale-fast': { minSide: 32, maxSide: 1536, minPixels: 1024, maxPixels: 1_048_576 },
  'upscale-conservative': { minSide: 64, maxPixels: 9_437_184, maxAspect: 2.5 },
  'upscale-creative': { minSide: 64, minPixels: 4096, maxPixels: 1_048_576 },
  'remove-background': { minSide: 64, maxPixels: 9_437_184, maxAspect: 2.5 },
  erase: { minSide: 64, maxPixels: 9_437_184, maxAspect: 2.5 },
  outpaint: { minSide: 64, maxPixels: 9_437_184, maxAspect: 2.5 },
};

/** The size a tool's input is sent at, or why the image can't be used with the tool. */
export type ToolInputFit = { ok: true; size: Size } | { ok: false; problem: string };

/**
 * The size to send a version at for a tool: its own size, scaled down (never up) to fit the tool's largest side
 * and pixel count. An image that is still too small, or too narrow, can't be used: the problem is in words for
 * the user.
 */
export function fitToolInput(toolId: ToolId, size: Size): ToolInputFit {
  const limits = TOOL_INPUT_LIMITS[toolId];
  const name = TOOL_NAMES[toolId];
  const ratio = Math.max(size.width, size.height) / Math.min(size.width, size.height);
  if (limits.maxAspect !== undefined && ratio > limits.maxAspect) {
    return {
      ok: false,
      problem: `${name} works on images no wider or taller than ${limits.maxAspect} to 1. Pick another version or tool.`,
    };
  }
  let scale = 1;
  if (limits.maxSide !== undefined) {
    scale = Math.min(scale, limits.maxSide / Math.max(size.width, size.height));
  }
  scale = Math.min(scale, Math.sqrt(limits.maxPixels / (size.width * size.height)));
  const fitted = {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  };
  const tooSmall =
    Math.min(fitted.width, fitted.height) < limits.minSide ||
    (limits.minPixels !== undefined && fitted.width * fitted.height < limits.minPixels);
  if (tooSmall) {
    return {
      ok: false,
      problem: `This image is too small for ${name}. Pick a larger version or another tool.`,
    };
  }
  return { ok: true, size: fitted };
}
