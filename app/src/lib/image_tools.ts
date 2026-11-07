import {
  MAX_OUTPAINT_PIXELS,
  TOOL_OF,
  UPSCALE_MODES,
  upscaleToolId,
  type ImageTool,
  type ToolId,
  type ToolJobRequest,
  type UpscaleMode,
} from '@pictora/core';
import type { PublicTool } from './tool_catalog';

/** How the Tools menu presents each tool (tech design 5.5). */
export const TOOL_MENU: readonly { tool: ImageTool; label: string; description: string }[] = [
  {
    tool: 'upscale',
    label: 'Upscale',
    description: 'Makes the picture larger and sharper, as a new version.',
  },
  {
    tool: 'remove-background',
    label: 'Remove background',
    description: 'Keeps the subject and makes the background transparent, as a new PNG version.',
  },
  {
    tool: 'erase',
    label: 'Erase object',
    description:
      'Paint over something to remove it; the area is filled in to match its surroundings.',
  },
  {
    tool: 'outpaint',
    label: 'Outpaint',
    description: 'Extends the picture beyond its edges in the directions you choose.',
  },
];

/** What each upscale mode does, for its choice in the upscale form. */
export const UPSCALE_MODE_TEXT: Readonly<Record<UpscaleMode, { label: string; detail: string }>> = {
  fast: { label: 'Fast', detail: '4 times larger in seconds, keeping the picture as it is.' },
  conservative: {
    label: 'Conservative',
    detail: 'Up to 4K, keeping the details faithful to the original.',
  },
  creative: { label: 'Creative', detail: 'Up to 4K, adding new detail as it enlarges.' },
};

/** The tools of the catalogue that belong to a menu entry. */
export function toolsOf(tools: readonly PublicTool[], tool: ImageTool): PublicTool[] {
  return tools.filter((candidate) => TOOL_OF[candidate.id] === tool);
}

/** The upscale modes the catalogue offers, in the order fast, conservative, creative. */
export function upscaleModes(tools: readonly PublicTool[]): UpscaleMode[] {
  const offered = new Set<ToolId>(tools.map((tool) => tool.id));
  return UPSCALE_MODES.filter((mode) => offered.has(upscaleToolId(mode)));
}

/** The price of one run of a tool, or undefined when the catalogue doesn't offer it. */
export function toolCost(tools: readonly PublicTool[], id: ToolId): number | undefined {
  return tools.find((tool) => tool.id === id)?.costPoints;
}

/** How far an outpaint extends each side, as the form holds them. */
export interface OutpaintForm {
  left: number;
  right: number;
  up: number;
  down: number;
}

/** A side's value from its input: a whole number from 0 to 2,000, or 0 for anything else. */
export function outpaintPixels(value: string): number {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(MAX_OUTPAINT_PIXELS, number);
}

/** The size an outpaint makes, before the tool scales an over-large source down. */
export function outpaintSize(
  size: { width: number; height: number },
  sides: OutpaintForm,
): { width: number; height: number } {
  return {
    width: size.width + sides.left + sides.right,
    height: size.height + sides.up + sides.down,
  };
}

/** What the forms collect, for `toolJobRequest`. */
export type ToolChoice =
  | { tool: 'upscale'; mode: UpscaleMode; prompt: string }
  | { tool: 'remove-background' }
  | { tool: 'erase'; maskKey: string }
  | { tool: 'outpaint'; sides: OutpaintForm; prompt: string };

/** The `POST /api/jobs` body for a tool run on a version. */
export function toolJobRequest(
  imageId: string,
  version: number,
  choice: ToolChoice,
): ToolJobRequest {
  const base = { type: 'tool' as const, imageId, version };
  switch (choice.tool) {
    case 'upscale': {
      const prompt = choice.prompt.trim();
      return {
        ...base,
        tool: 'upscale',
        params: { mode: choice.mode, ...(choice.mode !== 'fast' && prompt ? { prompt } : {}) },
      };
    }
    case 'remove-background':
      return { ...base, tool: 'remove-background', params: {} };
    case 'erase':
      return { ...base, tool: 'erase', params: { maskKey: choice.maskKey } };
    case 'outpaint': {
      const prompt = choice.prompt.trim();
      return {
        ...base,
        tool: 'outpaint',
        params: { ...choice.sides, ...(prompt ? { prompt } : {}) },
      };
    }
  }
}

/** The tool id a choice runs, for its price. */
export function choiceToolId(choice: ToolChoice): ToolId {
  return choice.tool === 'upscale' ? upscaleToolId(choice.mode) : choice.tool;
}
