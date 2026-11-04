'use client';

import {
  APP_GENERATE_DEFAULTS,
  ASPECTS,
  AUTO_MODEL_ID,
  MAX_AVOID_LENGTH,
  type GenerateDefaults,
  type Quality,
  type StyleId,
} from '@pictora/core';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { choicesForModel, costPerImage, generateModels, pointsText } from '../lib/generate_options';
import type { PublicModel, PublicStyle } from '../lib/models_response';
import {
  AspectPicker,
  QualityPicker,
  VariationsPicker,
  type QualityOption,
} from './generate_controls';

export interface GenerateDefaultsCardProps {
  models: PublicModel[];
  styles: PublicStyle[];
  /** The user's saved defaults, or the app defaults. */
  defaults: GenerateDefaults;
  /** Whether `defaults` are the user's own. */
  saved: boolean;
}

/** The options a model (or, with Auto, any model) offers, as the generate screen shows them. */
function offered(models: readonly PublicModel[], modelId: string) {
  const model = models.find((candidate) => candidate.id === modelId);
  const offering = model ? [model] : models;
  const any = (has: (candidate: PublicModel) => boolean | undefined) =>
    offering.some((candidate) => has(candidate) === true);
  return {
    model,
    aspects: ASPECTS.filter((aspect) =>
      any((candidate) => candidate.capabilities.aspects.includes(aspect)),
    ),
    transparent: any((candidate) => candidate.capabilities.transparentBackground),
    later: any((candidate) => candidate.capabilities.batch),
    avoid: any((candidate) => candidate.capabilities.negativePrompt),
    /** The lowest points per image at the quality among the offering models. */
    perImage: (quality: Quality) =>
      offering
        .map((candidate) => costPerImage(candidate, quality))
        .filter((points): points is number => points !== undefined)
        .reduce<number | undefined>(
          (lowest, points) => (lowest === undefined ? points : Math.min(lowest, points)),
          undefined,
        ),
  };
}

/** The defaults with options the chosen model doesn't offer switched off or cleared, as they are saved. */
function fitted(models: readonly PublicModel[], defaults: GenerateDefaults): GenerateDefaults {
  const options = offered(models, defaults.modelId);
  return {
    ...defaults,
    avoid: options.avoid ? defaults.avoid.trim() : '',
    transparentBackground: options.transparent && defaults.transparentBackground,
    deliverLater: options.later && defaults.deliverLater,
  };
}

const same = (a: GenerateDefaults, b: GenerateDefaults) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The account page's Defaults card (GEN-11): every option the generate screen has, which a new form
 * starts with on every visit and device. Save stores them; Reset goes back to the app defaults. Only the options
 * the chosen model (or, with Auto, any model) offers are shown, as on the generate screen.
 */
export function GenerateDefaultsCard({
  models: allModels,
  styles,
  defaults: initial,
  saved: initiallySaved,
}: GenerateDefaultsCardProps) {
  const models = generateModels(allModels);
  const ids = {
    form: useId(),
    style: useId(),
    model: useId(),
    aspect: useId(),
    quality: useId(),
    variations: useId(),
    transparent: useId(),
    later: useId(),
    avoid: useId(),
    enhance: useId(),
  };
  // A saved model that has gone shows as Auto, which is what the generate screen uses instead.
  const [draft, setDraft] = useState<GenerateDefaults>(() =>
    models.some((model) => model.id === initial.modelId)
      ? initial
      : { ...initial, modelId: AUTO_MODEL_ID },
  );
  const [stored, setStored] = useState<GenerateDefaults>(initial);
  const [saved, setSaved] = useState(initiallySaved);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  const options = offered(models, draft.modelId);
  const changed = !same(fitted(models, draft), stored);

  function update(change: Partial<GenerateDefaults>) {
    setDraft((current) => ({ ...current, ...change }));
    setStatus(undefined);
    setError(undefined);
  }

  function chooseModel(modelId: string) {
    const model = models.find((candidate) => candidate.id === modelId);
    // A model keeps the quality and aspect it offers, as on the generate screen; Auto keeps them as they are.
    update(model ? choicesForModel(model, draft) : { modelId });
  }

  function qualityOption(quality: Quality): QualityOption {
    const perImage = options.perImage(quality);
    if (perImage === undefined) {
      return {
        disabled: true,
        hint: options.model ? `Not offered by ${options.model.displayName}` : 'Not available',
      };
    }
    return {
      disabled: false,
      hint: options.model ? `${pointsText(perImage)} per image` : `from ${pointsText(perImage)}`,
    };
  }

  async function send(method: 'PUT' | 'DELETE') {
    setBusy(true);
    setStatus(undefined);
    setError(undefined);
    try {
      const response = await fetch('/api/me/defaults', {
        method,
        ...(method === 'PUT'
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(fitted(models, draft)),
            }
          : {}),
      });
      const body = (await response.json().catch(() => ({}))) as {
        defaults?: GenerateDefaults;
        error?: string;
      };
      if (!response.ok || !body.defaults) {
        setError(body.error ?? "We couldn't save your defaults. Please try again.");
        return;
      }
      setDraft(body.defaults);
      setStored(body.defaults);
      setSaved(method === 'PUT');
      setStatus(
        method === 'PUT'
          ? 'Defaults saved. New images start with them.'
          : 'Defaults reset to the app defaults.',
      );
    } catch {
      setError('Something went wrong. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Defaults</h2>
        </CardTitle>
        <CardDescription>
          The settings the Create page starts with, on every device. You can still change them for
          each image.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          id={ids.form}
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed && !busy) void send('PUT');
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={ids.style}>Style</Label>
            <Select
              value={draft.style}
              onValueChange={(next) => update({ style: next as StyleId })}
            >
              <SelectTrigger id={ids.style} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {styles.map((style) => (
                  <SelectItem key={style.id} value={style.id}>
                    {style.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.model}>Model</Label>
            <Select value={draft.modelId} onValueChange={chooseModel}>
              <SelectTrigger id={ids.model} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_MODEL_ID}>Auto (recommended)</SelectItem>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.aspect}>Aspect ratio</Label>
            <AspectPicker
              id={ids.aspect}
              aspects={options.aspects}
              value={draft.aspect}
              onChange={(aspect) => update({ aspect })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.quality}>Quality</Label>
            <QualityPicker
              id={ids.quality}
              value={draft.quality}
              option={qualityOption}
              onChange={(quality) => update({ quality })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.variations}>Variations</Label>
            <VariationsPicker
              id={ids.variations}
              value={draft.count}
              cost={(count) => (options.perImage(draft.quality) ?? 0) * count}
              onChange={(count) => update({ count })}
            />
          </div>
          <div className="flex flex-col justify-end gap-3 sm:col-span-2">
            <SwitchRow
              id={ids.enhance}
              label="Enhance prompt"
              checked={draft.enhance}
              onChange={(enhance) => update({ enhance })}
            />
            {options.transparent && (
              <SwitchRow
                id={ids.transparent}
                label="Transparent background"
                checked={draft.transparentBackground}
                onChange={(transparentBackground) => update({ transparentBackground })}
              />
            )}
            {options.later && (
              <SwitchRow
                id={ids.later}
                label="Save points: deliver later"
                hint="Half the points. Images arrive in your gallery within 24 hours."
                checked={draft.deliverLater}
                onChange={(deliverLater) => update({ deliverLater })}
              />
            )}
          </div>
          {options.avoid && (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={ids.avoid}>Avoid (optional)</Label>
              <Input
                id={ids.avoid}
                type="text"
                maxLength={MAX_AVOID_LENGTH}
                value={draft.avoid}
                placeholder="Things to leave out, for example text or blur"
                onChange={(event) => update({ avoid: event.target.value })}
              />
            </div>
          )}
        </form>
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-3">
        <div className="flex flex-wrap gap-2">
          <Button type="submit" form={ids.form} disabled={!changed || busy}>
            {busy ? 'Saving…' : 'Save defaults'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || (!saved && same(draft, APP_GENERATE_DEFAULTS))}
            onClick={() => void send('DELETE')}
          >
            Reset to app defaults
          </Button>
        </div>
        <p className="text-sm text-muted-foreground" role="status">
          {status}
        </p>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardFooter>
    </Card>
  );
}

/** A setting that is on or off, with its label beside the switch and an optional hint under it. */
function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hintId = `${id}-hint`;
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={hint ? hintId : undefined}
        className="mt-0.5"
      />
      <div className="grid gap-1">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        {hint && (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
