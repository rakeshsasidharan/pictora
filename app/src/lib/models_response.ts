import {
  QUALITIES,
  STYLE_PRESETS,
  pausedQuality,
  suggestedModelId,
  type ModelConfig,
  type PremiumPause,
  type StyleId,
} from '@pictora/core';

/** A model as the UI sees it: what to show and what it costs, without provider settings. */
export interface PublicModel {
  id: string;
  provider: ModelConfig['provider'];
  displayName: string;
  strengths: string[];
  capabilities: ModelConfig['capabilities'];
  /**
   * Points per image for each quality the model offers, in quality order. `paused` marks a quality switched
   * off because the month's platform spend reached the cap; the UI disables it.
   */
  qualities: { quality: (typeof QUALITIES)[number]; costPoints: number; paused?: true }[];
  defaultFor: ModelConfig['defaultFor'];
  eolDate?: string;
}

export interface PublicStyle {
  id: StyleId;
  name: string;
  /** The enabled model this style suggests, if one is enabled. */
  suggestedModelId?: string;
}

/** The `GET /api/models` body (GEN-5): the enabled models and the style presets. */
export interface ModelsResponse {
  models: PublicModel[];
  styles: PublicStyle[];
  /** While premium qualities are paused (tech design 4.1): when they come back, as ISO 8601 UTC. */
  premiumPausedUntil?: string;
}

/** The models as the UI sees them; during a premium pause, every quality but draft is marked paused. */
export function modelsResponse(
  enabled: readonly ModelConfig[],
  pause?: PremiumPause,
): ModelsResponse {
  return {
    ...(pause ? { premiumPausedUntil: pause.until.toISOString() } : {}),
    models: enabled.map((model) => ({
      id: model.id,
      provider: model.provider,
      displayName: model.displayName,
      strengths: model.strengths,
      capabilities: model.capabilities,
      qualities: QUALITIES.flatMap((quality) => {
        const config = model.qualities[quality];
        if (!config) return [];
        return [
          {
            quality,
            costPoints: config.costPoints,
            ...(pause && pausedQuality(quality) ? { paused: true as const } : {}),
          },
        ];
      }),
      defaultFor: model.defaultFor,
      ...(model.eolDate ? { eolDate: model.eolDate } : {}),
    })),
    styles: STYLE_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      suggestedModelId: suggestedModelId(preset.id, enabled),
    })),
  };
}
