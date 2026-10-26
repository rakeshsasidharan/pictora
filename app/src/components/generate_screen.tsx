'use client';

import {
  ASPECTS,
  AUTO_MODEL_ID,
  MAX_PROMPT_LENGTH,
  MIN_IMAGE_COUNT,
  batchPoints,
  promptAsksForText,
  routeModel,
  type Quality,
  type StyleId,
} from '@pictora/core';
import { ArrowUpIcon, ClockIcon, SparklesIcon, SquareDashedIcon } from 'lucide-react';
import {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  BATCH_POLL_INTERVAL_MS,
  DEFAULT_QUALITY,
  QUALITY_LABELS,
  choicesForModel,
  costPerImage,
  generateModels,
  initialForm,
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
import { notifyImagesChanged } from '../lib/images_changed';
import type { MeBody } from '../lib/jobs';
import type { PublicModel, PublicStyle } from '../lib/models_response';
import {
  AspectPicker,
  AvoidPicker,
  CountPicker,
  ModelPicker,
  QualityPicker,
  StylePicker,
  type QualityOption,
} from './generate_controls';
import { GenerateTurnView, type GenerateTurn } from './generate_turn';

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
  /** How often a batch job is checked (once a minute); tests shorten it. */
  batchPollIntervalMs?: number;
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

/** Prompts the empty thread offers; picking one fills the composer. */
export const EXAMPLE_PROMPTS = [
  'A lighthouse on a rocky coast at dusk, warm light in its windows',
  'A fox curled up asleep in autumn leaves',
  'A cosy reading nook by a rainy window, with a cup of tea',
  'A poster that says "Summer Fair" with paper lanterns',
] as const;

/**
 * The generate screen (GEN-1 to GEN-10, LIM-2), laid out like a chat: a thread of this visit's requests, each
 * prompt with its options and then its job's status and results, above a composer pinned to the bottom with
 * the prompt, the enhancer, the options (style, aspect ratio, quality, count, model) and the cost.
 */
export function GenerateScreen({
  models,
  styles,
  points: initialPoints,
  premiumPausedUntil,
  rerun,
  pollIntervalMs,
  pollTimeoutMs,
  batchPollIntervalMs = BATCH_POLL_INTERVAL_MS,
}: GenerateScreenProps) {
  const available = generateModels(models);
  const [initial] = useState(() => initialForm(styles, available, rerun));
  const [prompt, setPrompt] = useState(initial.prompt);
  const [avoid, setAvoid] = useState(initial.avoid);
  const [styleId, setStyleId] = useState<StyleId>(initial.styleId);
  const [choices, setChoices] = useState<ModelChoices | undefined>(initial.choices);
  const [count, setCount] = useState(MIN_IMAGE_COUNT);
  const [transparent, setTransparent] = useState(initial.transparent);
  /** "Save points: deliver later": a batch job at half the points, delivered within 24 hours. */
  const [later, setLater] = useState(false);
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
  /** This visit's requests, oldest first; they go when the page is left. */
  const [turns, setTurns] = useState<GenerateTurn[]>([]);
  /** Jobs the screen stopped following: finished, timed out or lost. */
  const [endedJobs, setEndedJobs] = useState<ReadonlySet<string>>(() => new Set());
  const promptBox = useRef<HTMLTextAreaElement>(null);
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
  const onJobFinish = useCallback(() => {
    void refreshPoints();
    // The sidebar history and points load again.
    notifyImagesChanged();
  }, [refreshPoints]);
  const onJobEnd = useCallback((jobId: string) => {
    setEndedJobs((ended) => (ended.has(jobId) ? ended : new Set(ended).add(jobId)));
  }, []);

  // Auto picks among the models that take batch jobs when the user saves points.
  const batchModels = available.filter((candidate) => candidate.capabilities.batch);
  const deliverLater = later && batchModels.length > 0;
  const routing = choices && {
    style: styleId,
    aspect: choices.aspect,
    needs: { transparentBackground: transparent, text: promptAsksForText(prompt) },
    models: routableModels(deliverLater ? batchModels : available),
    pausedQualities: pausedQualities(available),
  };
  // A batch costs half, rounded up, so it fits when the full price is at most twice the points left.
  const route =
    auto && routing
      ? routeModel({
          ...routing,
          quality: choices.quality,
          pointsLeft: points.left * (deliverLater ? 2 : 1),
          count,
        })
      : undefined;
  const model = available.find(
    (candidate) => candidate.id === (auto ? route?.modelId : choices?.modelId),
  );
  const chosenQuality = auto ? route?.quality : choices?.quality;
  if (!model || !choices || !routing || !chosenQuality) {
    return (
      <div data-slot="generate-screen" className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Create an image</h1>
        <p className="text-sm text-destructive" role="alert">
          No image models are available right now. Please try again later.
        </p>
      </div>
    );
  }

  const batchOffered = auto ? batchModels.length > 0 : model.capabilities.batch === true;
  const batch = later && batchOffered;
  const fullCost = route?.points ?? requestCost(model, chosenQuality, count);
  const cost = batch ? batchPoints(fullCost) : fullCost;
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
  function qualityOption(option: Quality): QualityOption {
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
  // A batch job takes hours and holds no slot, so the form stays open for the next request.
  const latest = turns.at(-1);
  const jobActive = latest !== undefined && !latest.batch && !endedJobs.has(latest.jobId);
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

  /** Enter sends, Shift+Enter starts a new line; Enter while composing text with an IME is left alone. */
  function onPromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function pickExample(example: string) {
    setPrompt(example);
    setFormError(undefined);
    promptBox.current?.focus();
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
      const avoidText = model.capabilities.negativePrompt ? avoid.trim() : '';
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'generate',
          prompt: text,
          ...(enhancedPrompt ? { enhancedPrompt } : {}),
          ...(avoidText ? { avoid: avoidText } : {}),
          style: styleId,
          modelId: auto ? AUTO_MODEL_ID : model.id,
          aspect: choices.aspect,
          quality: choices.quality,
          count,
          ...(!auto && model.capabilities.seed && seed !== undefined ? { seed } : {}),
          ...(transparentOffered && transparent ? { transparentBackground: true } : {}),
          ...(batch ? { delivery: 'batch' } : {}),
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
      const modelId = body.modelId ?? model.id;
      const styleName = styles.find((style) => style.id === styleId)?.name ?? styleId;
      const turn: GenerateTurn = {
        jobId: body.jobId,
        prompt: text,
        options: [
          styleId === 'none' ? 'No style' : styleName,
          choices.aspect,
          QUALITY_LABELS[chosenQuality ?? choices.quality],
          `${count} ${count === 1 ? 'image' : 'images'}`,
          auto ? 'Auto model' : model.displayName,
          ...(transparentOffered && transparent ? ['Transparent background'] : []),
          ...(avoidText ? [`Avoid: ${avoidText}`] : []),
          ...(enhancedPrompt ? ['Enhanced prompt'] : []),
          ...(batch ? ['Delivered later'] : []),
        ],
        pointsReserved: reserved,
        modelId,
        modelName: models.find((candidate) => candidate.id === modelId)?.displayName ?? modelId,
        count,
        batch,
      };
      setTurns((current) => [...current, turn]);
      setPoints((current) => ({ ...current, left: Math.max(0, current.left - reserved) }));
    } catch {
      setFormError('Something went wrong. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const sendLabel = submitting
    ? 'Starting…'
    : jobActive
      ? 'Generating…'
      : batch
        ? 'Schedule'
        : 'Generate';

  return (
    <TooltipProvider>
      {/* Tall enough to keep the composer at the bottom of the window below the page header. */}
      <div data-slot="generate-screen" className="flex min-h-[calc(100svh-7.5rem)] flex-col gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold">Create an image</h1>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {points.left} of {points.limit} points left today
          </p>
        </div>

        {turns.length === 0 ? (
          <section
            aria-labelledby="generate-greeting"
            className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center"
          >
            <h2 id="generate-greeting" className="text-2xl font-semibold tracking-tight">
              What would you like to create?
            </h2>
            <p className="text-muted-foreground">
              Describe an image below, or start from an example.
            </p>
            <ul aria-label="Example prompts" className="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
              {EXAMPLE_PROMPTS.map((example) => (
                <li key={example} className="flex">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto w-full justify-start px-4 py-3 text-left whitespace-normal"
                    onClick={() => pickExample(example)}
                  >
                    {example}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <ol aria-label="Your requests" className="flex flex-1 flex-col gap-8">
            {turns.map((turn) => (
              <GenerateTurnView
                key={turn.jobId}
                turn={turn}
                pollIntervalMs={pollIntervalMs}
                pollTimeoutMs={pollTimeoutMs}
                batchPollIntervalMs={batchPollIntervalMs}
                onFinish={onJobFinish}
                onEnd={onJobEnd}
              />
            ))}
          </ol>
        )}

        {/* Below the thread rather than in the pinned composer, so it never covers the thread. */}
        {enhanceOn && enhanced && (
          <section
            aria-label="Enhanced prompt"
            className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3"
          >
            <label htmlFor="enhanced-prompt" className="text-sm font-medium">
              Enhanced prompt
            </label>
            <Textarea
              id="enhanced-prompt"
              rows={3}
              maxLength={MAX_PROMPT_LENGTH}
              value={enhanced.text}
              className="max-h-40 bg-background"
              onChange={(event) => setEnhanced({ ...enhanced, text: event.target.value })}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!affordable || busy || !enhanced.text.trim()}
                onClick={() => void run(true)}
              >
                Regenerate with this prompt
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={useMyWords}>
                Use my words
              </Button>
            </div>
          </section>
        )}

        <form
          onSubmit={submit}
          noValidate
          className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-2 bg-background px-1 pt-2 pb-4"
        >
          {premiumPausedUntil && (
            <p className="text-sm text-muted-foreground" role="status">
              {premiumPausedText(premiumPausedUntil)}
            </p>
          )}
          {notice && (
            <p className="text-sm text-muted-foreground" role="status">
              {notice}
            </p>
          )}
          <div className="flex flex-col gap-2 rounded-2xl border bg-card p-3 shadow-sm focus-within:border-ring">
            <label htmlFor="prompt" className="sr-only">
              Describe your image
            </label>
            <Textarea
              ref={promptBox}
              id="prompt"
              rows={2}
              maxLength={MAX_PROMPT_LENGTH}
              value={prompt}
              placeholder="Describe the image you want to create"
              aria-describedby="prompt-count"
              className="max-h-48 min-h-12 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={onPromptKeyDown}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Toggle
                    variant="outline"
                    size="sm"
                    aria-label="Enhance prompt"
                    pressed={enhanceOn}
                    onPressedChange={toggleEnhance}
                  >
                    <SparklesIcon aria-hidden="true" />
                    <span className="hidden sm:inline">Enhance</span>
                  </Toggle>
                </TooltipTrigger>
                <TooltipContent>
                  Adds detail about the subject, composition and lighting. You can edit the result.
                </TooltipContent>
              </Tooltip>
              <StylePicker styles={styles} value={styleId} onChange={chooseStyle} />
              <AspectPicker
                aspects={aspects}
                value={choices.aspect}
                onChange={(aspect) => setChoices({ ...choices, aspect })}
              />
              <QualityPicker
                value={choices.quality}
                option={qualityOption}
                onChange={(quality) => setChoices({ ...choices, quality })}
              />
              <CountPicker value={count} onChange={setCount} />
              {transparentOffered && (
                <Toggle
                  variant="outline"
                  size="sm"
                  aria-label="Transparent background"
                  pressed={transparent}
                  onPressedChange={setTransparent}
                >
                  <SquareDashedIcon aria-hidden="true" />
                  <span className="hidden sm:inline">Transparent</span>
                </Toggle>
              )}
              {model.capabilities.negativePrompt && (
                <AvoidPicker value={avoid} onChange={setAvoid} />
              )}
              {batchOffered && (
                <Toggle
                  variant="outline"
                  size="sm"
                  aria-label="Save points: deliver later"
                  aria-describedby="deliver-later-hint"
                  pressed={later}
                  onPressedChange={setLater}
                >
                  <ClockIcon aria-hidden="true" />
                  <span className="hidden sm:inline">Save points</span>
                </Toggle>
              )}
              <ModelPicker
                models={available}
                auto={auto}
                modelId={model.id}
                onAuto={() => setAuto(true)}
                onModel={chooseModel}
              />
            </div>

            {batchOffered && (
              // Read out with the toggle; shown once it is on.
              <p
                id="deliver-later-hint"
                className={later ? 'text-xs text-muted-foreground' : 'sr-only'}
              >
                Half the points. Your images arrive in your gallery within 24 hours, often much
                sooner. The points stay reserved until then, and come back if the images don&apos;t.
              </p>
            )}
            {!auto && model.capabilities.seed && seed !== undefined && (
              <p className="text-xs text-muted-foreground">
                Uses seed {seed} from the original image, so the result comes out close to it.{' '}
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto p-0"
                  onClick={() => setSeed(undefined)}
                >
                  Use a random seed
                </Button>
              </p>
            )}

            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs text-muted-foreground">
                <p id="cost" className="text-sm font-medium text-foreground">
                  Uses {cost} of your {points.left} points today
                  {batch ? ` (half of ${fullCost}, delivered later)` : ''}
                </p>
                {auto && (
                  <p aria-live="polite">
                    Auto picks {model.displayName}
                    {reasonText ? `: ${reasonText}` : ''}.
                  </p>
                )}
                <p id="prompt-count">
                  {prompt.length} / {MAX_PROMPT_LENGTH}
                </p>
              </div>
              <Button type="submit" disabled={!affordable || busy} aria-describedby="cost">
                {sendLabel}
                <ArrowUpIcon aria-hidden="true" />
              </Button>
            </div>
          </div>

          {!affordable && (
            <p className="text-sm text-destructive">
              You don&apos;t have enough points left today. Pick a lower quality or fewer images, or
              come back after 00:00 UTC.
            </p>
          )}
          {formError && (
            <p className="text-sm text-destructive" role="alert">
              {formError}
            </p>
          )}
        </form>
      </div>
    </TooltipProvider>
  );
}
