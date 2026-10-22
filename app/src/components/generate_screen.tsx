'use client';

import {
  ASPECTS,
  AUTO_MODEL_ID,
  MAX_AVOID_LENGTH,
  MAX_IMAGE_COUNT,
  MAX_PROMPT_LENGTH,
  MIN_IMAGE_COUNT,
  QUALITIES,
  promptAsksForText,
  routeModel,
  type Quality,
  type StyleId,
} from '@pictora/core';
import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  DEFAULT_QUALITY,
  QUALITY_LABELS,
  aspectRatioStyle,
  choicesForModel,
  costPerImage,
  generateModels,
  initialForm,
  modelCostSummary,
  pausedQualities,
  pointsText,
  premiumPausedText,
  qualityPaused,
  requestCost,
  routableModels,
  routeReasonText,
  type ModelChoices,
} from '../lib/generate_options';
import type { RerunSettings } from '../lib/images';
import type { MeBody } from '../lib/jobs';
import type { PublicModel, PublicStyle } from '../lib/models_response';
import { SAMPLE_IMAGES } from '../lib/sample_images';
import { EDIT_PATH } from '../lib/site';
import { useJobStatus } from '../lib/use_job_status';
import { JobProgress } from './job_progress';

/** Today's points as the screen shows them (LIM-2). */
export interface PointsLeft {
  left: number;
  limit: number;
}

export interface GenerateScreenProps {
  /** The enabled models the app can queue jobs for. */
  models: PublicModel[];
  styles: PublicStyle[];
  points: PointsLeft;
  /** While premium qualities are paused because the month's budget is used up: when they return (ISO 8601). */
  premiumPausedUntil?: string;
  /** A gallery image's settings to start from, for "Rerun" (GAL-3). */
  rerun?: RerunSettings;
  /** Polling settings; tests shorten them. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface SubmittedJob {
  id: string;
  pointsReserved: number;
  prompt: string;
  /** The model the job runs on, which Auto picks on the server. */
  modelId: string;
}

/** The enhancer's output for one prompt, style and model, as the user may have edited it (ENH-2). */
interface EnhancedPrompt {
  /** The prompt, style and model it was made for; a change to any of them enhances again. */
  source: string;
  text: string;
}

/** Where the "Enhance prompt" toggle is remembered, per browser (ENH-1). */
export const ENHANCE_STORAGE_KEY = 'pictora.enhancePrompt';

const enhanceListeners = new Set<() => void>();

function storedEnhanceSetting(): boolean {
  try {
    return window.localStorage.getItem(ENHANCE_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function storeEnhanceSetting(on: boolean): void {
  try {
    window.localStorage.setItem(ENHANCE_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Private windows may refuse storage; the toggle still works for this visit.
  }
  for (const listener of enhanceListeners) listener();
}

/** Follows the stored setting, including changes made in other tabs. */
function subscribeEnhanceSetting(listener: () => void): () => void {
  enhanceListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    enhanceListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

type Enhancement =
  | { kind: 'enhanced'; text: string }
  | { kind: 'own-words'; notice: string }
  | { kind: 'refused'; error: string };

/**
 * Asks `/api/enhance` for a richer prompt. A flagged output, an unavailable enhancer or a network error fall
 * back to the user's own words with a notice; a blocked prompt or an account refusal stops the request.
 */
async function requestEnhancement(
  prompt: string,
  style: StyleId,
  modelId: string,
): Promise<Enhancement> {
  try {
    const response = await fetch('/api/enhance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, style, modelId }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      enhancedPrompt?: string;
      fallback?: boolean;
      error?: string;
    };
    if (response.ok && body.enhancedPrompt) {
      if (body.fallback) {
        return {
          kind: 'own-words',
          notice: "We used your own words, because the enhanced prompt didn't pass our checks.",
        };
      }
      return { kind: 'enhanced', text: body.enhancedPrompt };
    }
    if (response.status === 403 || response.status === 422 || response.status === 429) {
      return { kind: 'refused', error: body.error ?? "We couldn't enhance your prompt." };
    }
    return {
      kind: 'own-words',
      notice: "The prompt enhancer isn't available right now, so we used your own words.",
    };
  } catch {
    return {
      kind: 'own-words',
      notice: "The prompt enhancer isn't available right now, so we used your own words.",
    };
  }
}

const COUNTS = Array.from(
  { length: MAX_IMAGE_COUNT - MIN_IMAGE_COUNT + 1 },
  (_, index) => MIN_IMAGE_COUNT + index,
);

const SAMPLE_BY_STYLE = new Map(SAMPLE_IMAGES.map((sample) => [sample.style, sample]));
const THUMBNAIL_SIZE = 72;

/**
 * The generate screen (GEN-1 to GEN-10, LIM-2): prompt, style, aspect ratio, quality, model and count, the
 * cost before generating, then the job's status and results.
 */
export function GenerateScreen({
  models,
  styles,
  points: initialPoints,
  premiumPausedUntil,
  rerun,
  pollIntervalMs,
  pollTimeoutMs,
}: GenerateScreenProps) {
  const available = generateModels(models);
  const [initial] = useState(() => initialForm(styles, available, rerun));
  const [prompt, setPrompt] = useState(initial.prompt);
  const [avoid, setAvoid] = useState(initial.avoid);
  const [styleId, setStyleId] = useState<StyleId>(initial.styleId);
  const [choices, setChoices] = useState<ModelChoices | undefined>(initial.choices);
  const [count, setCount] = useState(MIN_IMAGE_COUNT);
  const [transparent, setTransparent] = useState(initial.transparent);
  /**
   * Smart routing: the app picks the model from the style, quality, prompt and points left. A rerun starts on
   * the original model instead, unless it isn't available any more.
   */
  const [auto, setAuto] = useState(!rerun || initial.modelReplaced);
  /** A rerun's original seed (GAL-3), sent while the original model is chosen by hand and takes one. */
  const [seed, setSeed] = useState(initial.seed);
  const [points, setPoints] = useState(initialPoints);
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<SubmittedJob>();
  // The server render, and so hydration, assumes the default: on.
  const storedEnhanceOn = useSyncExternalStore(
    subscribeEnhanceSetting,
    storedEnhanceSetting,
    () => true,
  );
  /**
   * Set by "Use my words" for this visit only, without changing the remembered setting. A rerun uses what the
   * original used: its enhanced prompt, or the user's own words.
   */
  const [enhanceOverride, setEnhanceOverride] = useState<boolean | undefined>(
    rerun ? initial.enhancedPrompt !== undefined : undefined,
  );
  const enhanceOn = enhanceOverride ?? storedEnhanceOn;
  const [enhanced, setEnhanced] = useState<EnhancedPrompt | undefined>(() =>
    initial.enhancedPrompt && initial.choices
      ? {
          source: JSON.stringify([initial.prompt.trim(), initial.styleId, initial.choices.modelId]),
          text: initial.enhancedPrompt,
        }
      : undefined,
  );
  const [notice, setNotice] = useState<string | undefined>(() => {
    if (!initial.modelReplaced) return undefined;
    const name = available.find((model) => model.id === initial.choices?.modelId)?.displayName;
    return `The model this image was made with isn't available any more${name ? `, so we picked ${name}` : ''}.`;
  });

  const refreshPoints = useCallback(async () => {
    try {
      const response = await fetch('/api/me', { cache: 'no-store' });
      if (!response.ok) return;
      const me = (await response.json()) as MeBody;
      setPoints({ left: me.pointsLeft, limit: me.dailyLimit });
    } catch {
      // The display catches up on the next refresh.
    }
  }, []);
  const poll = useJobStatus(job?.id, {
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
    onFinish: () => void refreshPoints(),
  });

  const routing = choices && {
    style: styleId,
    aspect: choices.aspect,
    needs: { transparentBackground: transparent, text: promptAsksForText(prompt) },
    models: routableModels(available),
    pausedQualities: pausedQualities(available),
  };
  const route =
    auto && routing
      ? routeModel({ ...routing, quality: choices.quality, pointsLeft: points.left, count })
      : undefined;
  const model = available.find(
    (candidate) => candidate.id === (auto ? route?.modelId : choices?.modelId),
  );
  const chosenQuality = auto ? route?.quality : choices?.quality;
  if (!model || !choices || !routing || !chosenQuality) {
    return (
      <main className="generate">
        <h1>Create an image</h1>
        <p className="form-error" role="alert">
          No image models are available right now. Please try again later.
        </p>
      </main>
    );
  }

  const cost = route?.points ?? requestCost(model, chosenQuality, count);
  const transparentOffered = auto
    ? available.some((candidate) => candidate.capabilities.transparentBackground)
    : model.capabilities.transparentBackground;
  const aspects = auto
    ? ASPECTS.filter((aspect) =>
        available.some((candidate) => candidate.capabilities.aspects.includes(aspect)),
      )
    : model.capabilities.aspects;
  const reasonText =
    route &&
    routeReasonText(
      route.reason,
      route.quality,
      styles.find((style) => style.id === styleId)?.name ?? styleId,
    );

  /** What a quality costs per image, or why it can't be picked. With Auto, the model routing would pick. */
  function qualityOption(option: Quality): { disabled: boolean; hint: string } {
    if (!model || !routing) return { disabled: true, hint: '' };
    if (auto) {
      const picked = routeModel({
        ...routing,
        quality: option,
        pointsLeft: Number.POSITIVE_INFINITY,
      });
      if (!picked || picked.quality !== option) {
        return {
          disabled: true,
          hint: routing.pausedQualities.includes(option) ? 'Paused this month' : 'Not available',
        };
      }
      return { disabled: false, hint: `${pointsText(picked.points)} per image` };
    }
    const perImage = costPerImage(model, option);
    if (perImage === undefined) {
      return { disabled: true, hint: `Not offered by ${model.displayName}` };
    }
    if (qualityPaused(model, option)) return { disabled: true, hint: 'Paused this month' };
    return { disabled: false, hint: `${pointsText(perImage)} per image` };
  }
  const affordable = cost <= points.left;
  const jobActive =
    job !== undefined &&
    !poll.timedOut &&
    !poll.lost &&
    (poll.job === undefined || ['queued', 'running'].includes(poll.job.status));
  const busy = submitting || jobActive;

  function chooseModel(next: PublicModel) {
    // A rerun's seed only reproduces the image with the model that made it.
    if (auto || next.id !== choices?.modelId) setSeed(undefined);
    setAuto(false);
    setChoices((current) =>
      choicesForModel(next, current ?? { quality: DEFAULT_QUALITY, aspect: '1:1' }),
    );
    if (!next.capabilities.transparentBackground) setTransparent(false);
  }

  function chooseStyle(next: StyleId) {
    setStyleId(next);
    // Auto follows the style through routing.
    if (auto) return;
    // GEN-5: a style selects the model the registry suggests for it, when that model is available.
    const suggestedId = styles.find((style) => style.id === next)?.suggestedModelId;
    const suggested = available.find((candidate) => candidate.id === suggestedId);
    if (suggested) chooseModel(suggested);
  }

  function toggleEnhance(on: boolean) {
    setEnhanceOverride(undefined);
    storeEnhanceSetting(on);
    if (!on) setEnhanced(undefined);
  }

  /** "Use my words": drops the enhanced prompt, so the next images use exactly what the user typed (ENH-2). */
  function useMyWords() {
    setEnhanced(undefined);
    setEnhanceOverride(false);
    setNotice(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run();
  }

  /** Generates; `fromPanel` means "Regenerate with this prompt", which always uses the panel's text. */
  async function run(fromPanel = false) {
    if (!model || !choices || busy) return;
    const text = prompt.trim();
    if (!text) {
      setFormError('Describe the image you want to create.');
      return;
    }
    if (!affordable) return;
    setFormError(undefined);
    setNotice(undefined);
    setSubmitting(true);
    try {
      let finalPrompt: string | undefined;
      if (enhanceOn) {
        const source = JSON.stringify([text, styleId, model.id]);
        if (enhanced && (fromPanel || enhanced.source === source)) {
          // Reuse the enhanced prompt, with the user's edits, until the prompt, style or model changes.
          finalPrompt = enhanced.text.trim() || undefined;
          if (enhanced.source !== source) setEnhanced({ ...enhanced, source });
        } else {
          const enhancement = await requestEnhancement(text, styleId, model.id);
          if (enhancement.kind === 'refused') {
            setFormError(enhancement.error);
            return;
          }
          if (enhancement.kind === 'own-words') {
            setEnhanced(undefined);
            setNotice(enhancement.notice);
          } else {
            setEnhanced({ source, text: enhancement.text });
            finalPrompt = enhancement.text;
          }
        }
      }
      const enhancedPrompt = finalPrompt && finalPrompt !== text ? finalPrompt : undefined;
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'generate',
          prompt: text,
          ...(enhancedPrompt ? { enhancedPrompt } : {}),
          ...(model.capabilities.negativePrompt && avoid.trim() ? { avoid: avoid.trim() } : {}),
          style: styleId,
          modelId: auto ? AUTO_MODEL_ID : model.id,
          aspect: choices.aspect,
          quality: choices.quality,
          count,
          ...(!auto && model.capabilities.seed && seed !== undefined ? { seed } : {}),
          ...(transparentOffered && transparent ? { transparentBackground: true } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        jobId?: string;
        pointsReserved?: number;
        modelId?: string;
        error?: string;
      };
      if (response.status !== 202 || !body.jobId) {
        setFormError(body.error ?? "We couldn't start your images. Please try again.");
        void refreshPoints();
        return;
      }
      const reserved = body.pointsReserved ?? cost;
      setJob({
        id: body.jobId,
        pointsReserved: reserved,
        prompt: text,
        modelId: body.modelId ?? model.id,
      });
      setPoints((current) => ({ ...current, left: Math.max(0, current.left - reserved) }));
    } catch {
      setFormError('Something went wrong. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="generate">
      <div className="generate-heading">
        <h1>Create an image</h1>
        <p className="points-display" aria-live="polite">
          {points.left} of {points.limit} points left today
        </p>
        <Link href={EDIT_PATH}>Upload an image to edit</Link>
      </div>

      <form className="generate-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="prompt">Describe your image</label>
          <textarea
            id="prompt"
            rows={4}
            maxLength={MAX_PROMPT_LENGTH}
            value={prompt}
            aria-describedby="prompt-count"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <span id="prompt-count" className="field-hint">
            {prompt.length} / {MAX_PROMPT_LENGTH}
          </span>
        </div>

        {model.capabilities.negativePrompt && (
          <div className="field">
            <label htmlFor="avoid">Avoid (optional)</label>
            <input
              id="avoid"
              type="text"
              maxLength={MAX_AVOID_LENGTH}
              value={avoid}
              placeholder="Things to leave out, for example text or blur"
              onChange={(event) => setAvoid(event.target.value)}
            />
          </div>
        )}

        <label className="checkbox enhance-toggle">
          <input
            type="checkbox"
            checked={enhanceOn}
            onChange={(event) => toggleEnhance(event.target.checked)}
          />
          Enhance prompt
          <span className="field-hint">
            Adds detail about the subject, composition and lighting. You can edit the result.
          </span>
        </label>

        <fieldset className="style-picker">
          <legend>Style</legend>
          {styles.map((style) => {
            const sample = style.id === 'none' ? undefined : SAMPLE_BY_STYLE.get(style.id);
            return (
              <label key={style.id} className="option-card">
                <input
                  type="radio"
                  name="style"
                  value={style.id}
                  checked={styleId === style.id}
                  onChange={() => chooseStyle(style.id)}
                />
                {sample ? (
                  <Image
                    src={sample.src}
                    alt=""
                    width={THUMBNAIL_SIZE}
                    height={THUMBNAIL_SIZE}
                    className="style-thumbnail"
                    unoptimized
                  />
                ) : (
                  <span className="style-thumbnail style-thumbnail-none" aria-hidden="true">
                    Aa
                  </span>
                )}
                <span>{style.name}</span>
              </label>
            );
          })}
        </fieldset>

        <fieldset className="aspect-picker">
          <legend>Aspect ratio</legend>
          {aspects.map((aspect) => (
            <label key={aspect} className="option-card">
              <input
                type="radio"
                name="aspect"
                value={aspect}
                checked={choices.aspect === aspect}
                onChange={() => setChoices({ ...choices, aspect })}
              />
              <span
                className="aspect-icon"
                style={{ aspectRatio: aspectRatioStyle(aspect) }}
                aria-hidden="true"
              />
              <span>{aspect}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="quality-picker">
          <legend>Quality</legend>
          {premiumPausedUntil && (
            <p className="form-notice" role="status">
              {premiumPausedText(premiumPausedUntil)}
            </p>
          )}
          {QUALITIES.map((quality) => {
            const option = qualityOption(quality);
            return (
              <label key={quality} className="option-card">
                <input
                  type="radio"
                  name="quality"
                  value={quality}
                  checked={choices.quality === quality}
                  disabled={option.disabled}
                  onChange={() => setChoices({ ...choices, quality })}
                />
                <span>{QUALITY_LABELS[quality]}</span>
                <span className="field-hint">{option.hint}</span>
              </label>
            );
          })}
        </fieldset>

        <div className="generate-row">
          <div className="field">
            <label htmlFor="count">Number of images</label>
            <select
              id="count"
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
            >
              {COUNTS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          {transparentOffered && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={transparent}
                onChange={(event) => setTransparent(event.target.checked)}
              />
              Transparent background
            </label>
          )}
        </div>

        {!auto && model.capabilities.seed && seed !== undefined && (
          <p className="form-notice seed-notice">
            Uses seed {seed} from the original image, so the result comes out close to it.{' '}
            <button type="button" className="link-button" onClick={() => setSeed(undefined)}>
              Use a random seed
            </button>
          </p>
        )}

        <details className="advanced">
          <summary>Advanced</summary>
          <fieldset className="model-picker">
            <legend>Model</legend>
            <label className="model-option">
              <input
                type="radio"
                name="model"
                value={AUTO_MODEL_ID}
                checked={auto}
                onChange={() => setAuto(true)}
              />
              <span className="model-name">Auto (recommended)</span>
              <span className="field-hint">
                Picks a model for your style, quality, prompt and points left
              </span>
            </label>
            {available.map((candidate) => (
              <label key={candidate.id} className="model-option">
                <input
                  type="radio"
                  name="model"
                  value={candidate.id}
                  checked={!auto && candidate.id === model.id}
                  onChange={() => chooseModel(candidate)}
                />
                <span className="model-name">{candidate.displayName}</span>
                <span className="field-hint">{candidate.strengths.join(', ')}</span>
                <span className="field-hint">{modelCostSummary(candidate)}</span>
              </label>
            ))}
          </fieldset>
        </details>

        <div className="generate-submit">
          <p id="cost" className="cost-display">
            Uses {cost} of your {points.left} points today
          </p>
          {auto && (
            <p className="field-hint auto-pick" aria-live="polite">
              Auto picks {model.displayName}
              {reasonText ? `: ${reasonText}` : ''}.
            </p>
          )}
          {!affordable && (
            <p className="form-error">
              You don&apos;t have enough points left today. Pick a lower quality or fewer images, or
              come back after 00:00 UTC.
            </p>
          )}
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <button
            type="submit"
            className="button button-primary"
            disabled={!affordable || busy}
            aria-describedby="cost"
          >
            {submitting ? 'Starting…' : jobActive ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </form>

      {notice && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
      {enhanceOn && enhanced && (
        <section className="enhanced-panel" aria-label="Enhanced prompt">
          <label htmlFor="enhanced-prompt">Enhanced prompt</label>
          <textarea
            id="enhanced-prompt"
            rows={4}
            maxLength={MAX_PROMPT_LENGTH}
            value={enhanced.text}
            onChange={(event) => setEnhanced({ ...enhanced, text: event.target.value })}
          />
          <div className="enhanced-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={!affordable || busy || !enhanced.text.trim()}
              onClick={() => void run(true)}
            >
              Regenerate with this prompt
            </button>
            <button type="button" className="button" onClick={useMyWords}>
              Use my words
            </button>
          </div>
        </section>
      )}
      {job && (
        <JobProgress
          key={job.id}
          poll={poll}
          pointsReserved={job.pointsReserved}
          prompt={job.prompt}
          modelName={
            models.find((candidate) => candidate.id === job.modelId)?.displayName ?? job.modelId
          }
        />
      )}
    </main>
  );
}
