import {
  QUALITIES,
  STYLE_PRESETS,
  suggestedModelId,
  type ModelConfig,
  type StyleId,
} from '@pictora/core';

/** A model as the UI sees it: what to show and what it costs, without provider settings. */
export interface PublicModel {
  id: string;
  provider: ModelConfig['provider'];
  displayName: string;
  strengths: string[];
  capabilities: ModelConfig['capabilities'];
  /** Points per image for each quality the model offers, in quality order. */
  qualities: { quality: (typeof QUALITIES)[number]; costPoints: number }[];
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
}

export function modelsResponse(enabled: readonly ModelConfig[]): ModelsResponse {
  return {
    models: enabled.map((model) => ({
      id: model.id,
      provider: model.provider,
      displayName: model.displayName,
      strengths: model.strengths,
      capabilities: model.capabilities,
      qualities: QUALITIES.flatMap((quality) => {
        const config = model.qualities[quality];
        return config ? [{ quality, costPoints: config.costPoints }] : [];
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
