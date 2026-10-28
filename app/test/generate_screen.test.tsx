// @vitest-environment jsdom
import { loadSeedRegistry, modelsForEnvironment, MAX_PROMPT_LENGTH } from '@pictora/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENHANCE_STORAGE_KEY,
  EXAMPLE_PROMPTS,
  GenerateScreen,
  PROMPT_COUNT_MARGIN,
  type PointsLeft,
} from '../src/components/generate_screen';
import type { RerunSettings } from '../src/lib/images';
import { IMAGES_CHANGED_EVENT } from '../src/lib/images_changed';
import { modelsResponse } from '../src/lib/models_response';
import { SAMPLE_IMAGES } from '../src/lib/sample_images';

const { models, styles } = modelsResponse(modelsForEnvironment(loadSeedRegistry(), 'dev'));
const JOB_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

function renderScreen(points: PointsLeft = { left: 25, limit: 25 }, pollTimeoutMs = 2_000) {
  return render(
    <GenerateScreen
      models={models}
      styles={styles}
      points={points}
      pollIntervalMs={5}
      pollTimeoutMs={pollTimeoutMs}
      batchPollIntervalMs={5}
    />,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The job ID the stub gives the nth job (from 1): JOB_ID first, so tests of one job can name it. */
const jobIdFor = (n: number) => (n === 1 ? JOB_ID : `${JOB_ID.slice(0, -1)}${n}`);

/**
 * A fetch stand-in: POST /api/jobs answers `created` (by default a new job ID each time), each job poll the next
 * status, /api/me `me`. POST /api/enhance answers `enhance`, or by default returns the prompt unchanged.
 */
function stubApi(options: {
  /** The answer to each POST /api/jobs; a function makes a fresh one for every job. */
  created?: Response | ((n: number) => Response);
  statuses?: Record<string, unknown>[];
  me?: Record<string, unknown>;
  enhance?: (body: { prompt: string; style: string; modelId: string }) => Response;
}) {
  const statuses = [...(options.statuses ?? [])];
  let jobs = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/enhance' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as {
        prompt: string;
        style: string;
        modelId: string;
      };
      return options.enhance?.(body) ?? json({ enhancedPrompt: body.prompt });
    }
    if (url === '/api/jobs' && init?.method === 'POST') {
      jobs += 1;
      if (typeof options.created === 'function') return options.created(jobs);
      return (
        options.created ?? json({ jobId: jobIdFor(jobs), status: 'queued', pointsReserved: 2 }, 202)
      );
    }
    if (url.startsWith('/api/jobs/')) {
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return json({ jobId: url.slice('/api/jobs/'.length), pointsReserved: 2, ...next });
    }
    if (url === '/api/me') return json({ pointsLeft: 25, dailyLimit: 25, ...options.me });
    if (url === '/api/reports') return json({ reportId: 'R1' }, 201);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Below 768 px the settings row folds into a button that opens the settings sheet. */
function setMobile(mobile: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: mobile,
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  window.matchMedia = globalThis.matchMedia;
}

const prompt = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Describe your image' });
const generate = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: /^(Generate|Starting|Generating)/ });
const schedule = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Schedule/ });
const radio = (name: string | RegExp) => screen.getByRole('radio', { name });
const checked = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true';
const pressed = (element: HTMLElement) => element.getAttribute('aria-pressed') === 'true';
const toggleButton = (name: string) => screen.getByRole('button', { name });
const modelButton = () => screen.getByRole('button', { name: /^Model:/ });

/** Opens the model popover and picks a model, or Auto. */
function chooseModel(name: string | RegExp) {
  if (!screen.queryByRole('radiogroup', { name: 'Model' })) fireEvent.click(modelButton());
  fireEvent.click(radio(name));
}

/** Opens the More popover, where it isn't open yet. */
function openMore() {
  const more = screen.getByRole('button', { name: /^More options/ });
  if (more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more);
}

/** One of the More options' toggles, opening the popover first. */
function extraToggle(name: 'Transparent background' | 'Save points: deliver later') {
  openMore();
  return toggleButton(name);
}

/** Whether More offers a toggle; opens the popover when there is one. */
function offersExtra(name: string): boolean {
  if (!screen.queryByRole('button', { name: /^More options/ })) return false;
  openMore();
  return screen.queryByRole('button', { name }) !== null;
}

/** Opens the style popover and picks a style. */
function chooseStyle(name: string) {
  if (!screen.queryByRole('radiogroup', { name: 'Style' })) {
    fireEvent.click(screen.getByRole('button', { name: /^Style:/ }));
  }
  fireEvent.click(radio(name));
}

/** Opens a select from the keyboard, as Radix's select does in jsdom, and returns its options. */
function openSelect(label: string): HTMLElement[] {
  fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'Enter' });
  return screen.getAllByRole('option');
}

/** Picks an option in the Quality or Aspect ratio select. */
function chooseOption(label: string, option: string | RegExp) {
  openSelect(label);
  fireEvent.click(screen.getByRole('option', { name: option }));
}

/** The quality option's text, with its cost per image, and whether it is disabled; closes the select. */
function qualityOption(name: RegExp): { text: string; disabled: boolean } {
  openSelect('Quality');
  const option = screen.getByRole('option', { name });
  const result = {
    text: option.textContent ?? '',
    disabled: option.getAttribute('aria-disabled') === 'true',
  };
  fireEvent.keyDown(option, { key: 'Escape' });
  return result;
}

/** Picks one image, or that many variations. */
function chooseCount(count: number) {
  chooseOption('Variations', new RegExp(`^${count === 1 ? '1 image' : `${count} variations`}`));
}

/** Opens More and returns the avoid field. */
function avoidField(): HTMLInputElement {
  openMore();
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Avoid (optional)' });
}

/** Opens the latest turn's enhanced prompt, where it is collapsed. */
function openEnhanced() {
  const toggle = screen.getByRole('button', { name: 'Enhanced prompt' });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
}

/** The turns of the thread, oldest first. */
function threadTurns(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Your requests' }))
    .getAllByRole('listitem')
    .filter((item) => item.parentElement?.getAttribute('aria-label') === 'Your requests');
}

function fillAndGenerate(text = 'A lighthouse at dusk') {
  fireEvent.change(prompt(), { target: { value: text } });
  fireEvent.click(generate());
}

/** The JSON body of each call to `url`, in order. */
function bodiesOf(fetchMock: ReturnType<typeof stubApi>, url: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([called]) => called === url)
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
}

const ENHANCED = 'A lighthouse on a rocky headland at dusk, warm lamp glow, violet sky';

describe('GenerateScreen', () => {
  beforeEach(() => setMobile(false));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  describe('prompt enhancer', () => {
    const toggle = () => toggleButton('Enhance prompt');
    const panel = () => screen.queryByRole('region', { name: 'Enhanced prompt' });
    const enhancedBox = () => {
      openEnhanced();
      return screen.getByRole('textbox', { name: 'Enhanced prompt' }) as HTMLTextAreaElement;
    };

    it('is on by default and remembers being turned off', () => {
      renderScreen();
      expect(pressed(toggle())).toBe(true);
      fireEvent.click(toggle());
      expect(pressed(toggle())).toBe(false);
      expect(window.localStorage.getItem(ENHANCE_STORAGE_KEY)).toBe('off');
      cleanup();

      renderScreen();
      expect(pressed(toggle())).toBe(false);
      fireEvent.click(toggle());
      expect(window.localStorage.getItem(ENHANCE_STORAGE_KEY)).toBe('on');
    });

    it('enhances first, shows the enhanced prompt and generates from it', async () => {
      const fetchMock = stubApi({ enhance: () => json({ enhancedPrompt: ENHANCED }) });
      renderScreen();
      fillAndGenerate('  A lighthouse at dusk ');

      await screen.findByText('Status: Queued');
      expect(bodiesOf(fetchMock, '/api/enhance')).toEqual([
        { prompt: 'A lighthouse at dusk', style: 'none', modelId: 'gpt-image-2' },
      ]);
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toMatchObject({
        prompt: 'A lighthouse at dusk',
        enhancedPrompt: ENHANCED,
      });
      // It sits collapsed in the request's turn.
      expect(panel()).toBeTruthy();
      expect(within(threadTurns()[0]!).getByRole('region', { name: 'Enhanced prompt' })).toBe(
        panel(),
      );
      expect(screen.queryByRole('textbox', { name: 'Enhanced prompt' })).toBeNull();
      expect(enhancedBox().value).toBe(ENHANCED);
    });

    it('moves the enhanced prompt to the newest turn', async () => {
      stubApi({
        enhance: ({ prompt: text }) => json({ enhancedPrompt: `${text}, detailed` }),
        statuses: [{ status: 'succeeded', images: [] }],
      });
      renderScreen();
      fillAndGenerate('A red fox');
      await screen.findByText('Status: Done');
      fillAndGenerate('A blue whale');
      await waitFor(() => expect(threadTurns()).toHaveLength(2));
      await waitFor(() => expect(screen.getAllByText('Status: Done')).toHaveLength(2));
      const [first, second] = threadTurns();
      expect(within(first!).queryByRole('region', { name: 'Enhanced prompt' })).toBeNull();
      expect(within(second!).getByRole('region', { name: 'Enhanced prompt' })).toBeTruthy();
      expect(enhancedBox().value).toBe('A blue whale, detailed');
    });

    it('regenerates from an edited enhanced prompt without enhancing again', async () => {
      const fetchMock = stubApi({
        enhance: () => json({ enhancedPrompt: ENHANCED }),
        statuses: [{ status: 'succeeded', images: [] }],
      });
      renderScreen();
      fillAndGenerate();
      await screen.findByText('Status: Done');

      fireEvent.change(enhancedBox(), { target: { value: `${ENHANCED}, light rain` } });
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate with this prompt' }));
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(2));
      expect(bodiesOf(fetchMock, '/api/jobs')[1]).toMatchObject({
        enhancedPrompt: `${ENHANCED}, light rain`,
      });
      expect(bodiesOf(fetchMock, '/api/enhance')).toHaveLength(1);
    });

    it('keeps the panel text when regenerating from it after the prompt changed', async () => {
      const fetchMock = stubApi({
        enhance: () => json({ enhancedPrompt: ENHANCED }),
        statuses: [{ status: 'succeeded', images: [] }],
      });
      renderScreen();
      fillAndGenerate();
      await screen.findByText('Status: Done');
      fireEvent.change(prompt(), { target: { value: 'A lighthouse at dawn' } });
      fireEvent.change(enhancedBox(), { target: { value: 'My own detailed prompt' } });
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate with this prompt' }));
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(2));
      expect(bodiesOf(fetchMock, '/api/jobs')[1]).toMatchObject({
        prompt: 'A lighthouse at dawn',
        enhancedPrompt: 'My own detailed prompt',
      });
      expect(bodiesOf(fetchMock, '/api/enhance')).toHaveLength(1);
    });

    it('enhances again when the prompt changes', async () => {
      const fetchMock = stubApi({
        enhance: ({ prompt: text }) => json({ enhancedPrompt: `${text}, detailed` }),
        statuses: [{ status: 'succeeded', images: [] }],
      });
      renderScreen();
      fillAndGenerate('A red fox');
      await screen.findByText('Status: Done');
      fillAndGenerate('A blue whale');
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(2));
      expect(bodiesOf(fetchMock, '/api/enhance').map((body) => body.prompt)).toEqual([
        'A red fox',
        'A blue whale',
      ]);
      expect(bodiesOf(fetchMock, '/api/jobs')[1]).toMatchObject({
        enhancedPrompt: 'A blue whale, detailed',
      });
    });

    it('"Use my words" goes back to the exact prompt', async () => {
      const fetchMock = stubApi({
        enhance: () => json({ enhancedPrompt: ENHANCED }),
        statuses: [{ status: 'succeeded', images: [] }],
      });
      renderScreen();
      fillAndGenerate();
      await screen.findByText('Status: Done');

      openEnhanced();
      fireEvent.click(screen.getByRole('button', { name: 'Use my words' }));
      expect(panel()).toBeNull();
      expect(pressed(toggle())).toBe(false);
      // Only for this visit: the remembered setting stays on.
      expect(window.localStorage.getItem(ENHANCE_STORAGE_KEY)).toBeNull();
      fireEvent.click(generate());
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(2));
      expect(bodiesOf(fetchMock, '/api/jobs')[1]).not.toHaveProperty('enhancedPrompt');
      expect(bodiesOf(fetchMock, '/api/jobs')[1]).toMatchObject({ prompt: 'A lighthouse at dusk' });
      expect(bodiesOf(fetchMock, '/api/enhance')).toHaveLength(1);
    });

    it('sends the exact words when turned off', async () => {
      const fetchMock = stubApi({ enhance: () => json({ enhancedPrompt: ENHANCED }) });
      renderScreen();
      fireEvent.click(toggle());
      fillAndGenerate('  my exact words ');
      await screen.findByText('Status: Queued');
      expect(bodiesOf(fetchMock, '/api/enhance')).toHaveLength(0);
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toMatchObject({ prompt: 'my exact words' });
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).not.toHaveProperty('enhancedPrompt');
      expect(panel()).toBeNull();
    });

    it('uses the user words with a notice when the output failed the checks', async () => {
      const fetchMock = stubApi({
        enhance: ({ prompt: text }) => json({ enhancedPrompt: text, fallback: true }),
      });
      renderScreen();
      fillAndGenerate();
      await screen.findByText('Status: Queued');
      expect(screen.getByText(/didn't pass our checks/).getAttribute('role')).toBe('status');
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).not.toHaveProperty('enhancedPrompt');
      expect(panel()).toBeNull();
    });

    it('carries on with the user words when the enhancer is unavailable', async () => {
      const fetchMock = stubApi({
        enhance: () => json({ error: 'unavailable', code: 'enhance_failed' }, 503),
      });
      renderScreen();
      fillAndGenerate();
      await screen.findByText('Status: Queued');
      expect(screen.getByText(/isn't available right now/).getAttribute('role')).toBe('status');
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toMatchObject({ prompt: 'A lighthouse at dusk' });
    });

    it('stops with the reason when the prompt is blocked', async () => {
      const fetchMock = stubApi({
        enhance: () =>
          json(
            {
              error: 'This prompt was blocked by our content policy. Try rewording it.',
              code: 'blocked',
            },
            422,
          ),
      });
      renderScreen();
      fillAndGenerate();
      expect((await screen.findByRole('alert')).textContent).toMatch(
        /blocked by our content policy/,
      );
      expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(0);
    });
  });

  describe('composer', () => {
    it('has no link to upload an image: the sidebar links to Edit', () => {
      renderScreen();
      expect(screen.queryByText('Upload an image to edit')).toBeNull();
      expect(screen.queryByRole('link', { name: /upload/i })).toBeNull();
      expect(document.querySelector('a[href="/edit"]')).toBeNull();
    });

    it('limits the prompt to 2,000 characters and counts them near the limit', () => {
      renderScreen();
      expect(prompt().getAttribute('maxlength')).toBe(String(MAX_PROMPT_LENGTH));
      fireEvent.change(prompt(), { target: { value: 'A red fox' } });
      expect(screen.queryByText(/\/ 2000$/)).toBeNull();
      expect(prompt().hasAttribute('aria-describedby')).toBe(false);

      const near = MAX_PROMPT_LENGTH - PROMPT_COUNT_MARGIN;
      fireEvent.change(prompt(), { target: { value: 'x'.repeat(near) } });
      const counter = screen.getByText(`${near} / 2000`);
      expect(prompt().getAttribute('aria-describedby')).toBe(counter.id);
      fireEvent.change(prompt(), { target: { value: 'x'.repeat(MAX_PROMPT_LENGTH) } });
      expect(screen.getByText('2000 / 2000')).toBeTruthy();
    });

    it('puts the settings in a row on the composer, above the prompt', () => {
      renderScreen();
      const row = screen.getByRole('group', { name: 'Image settings' });
      expect(within(row).getByRole('button', { name: 'Style: None' })).toBeTruthy();
      expect(within(row).getByRole('combobox', { name: 'Aspect ratio' })).toBeTruthy();
      expect(within(row).getByRole('combobox', { name: 'Quality' })).toBeTruthy();
      expect(within(row).getByRole('combobox', { name: 'Variations' })).toBeTruthy();
      expect(within(row).getByRole('button', { name: 'More options' })).toBeTruthy();
      expect(within(row).getByRole('button', { name: 'Model: Auto · GPT Image 2' })).toBeTruthy();
      // The row comes before the prompt in the composer, and the send button after it.
      const follows = (a: Node, b: Node) =>
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      expect(follows(row, prompt())).toBe(true);
      expect(follows(prompt(), generate())).toBe(true);
      // It shows from 768 px; below that the settings button stands in for it.
      expect(row.className).toMatch(/\bhidden\b/);
      expect(row.className).toMatch(/\bmd:flex\b/);
      expect(screen.getByRole('button', { name: /^Image settings:/ }).className).toMatch(
        /\bmd:hidden\b/,
      );
    });

    it('puts the cost on the send button', () => {
      renderScreen({ left: 20, limit: 25 });
      expect(generate().textContent).toBe('Generate · 6 points');
      // The full sentence is read out with the button.
      const cost = screen.getByText('Uses 6 of your 20 points today');
      expect(generate().getAttribute('aria-describedby')).toBe(cost.id);
      chooseOption('Quality', /^Draft/);
      expect(generate().textContent).toBe('Generate · 1 point');
    });

    it('counts the extra options set on the More button', () => {
      renderScreen();
      chooseModel(/^Mock/);
      expect(screen.getByRole('button', { name: 'More options' })).toBeTruthy();
      fireEvent.change(avoidField(), { target: { value: 'blur' } });
      fireEvent.click(toggleButton('Save points: deliver later'));
      expect(screen.getByRole('button', { name: 'More options, 2 on' })).toBeTruthy();
    });

    it('sends on Enter, but not on Shift+Enter', async () => {
      const fetchMock = stubApi({ statuses: [{ status: 'queued' }] });
      renderScreen();
      fireEvent.click(toggleButton('Enhance prompt'));
      fireEvent.change(prompt(), { target: { value: 'A red fox' } });
      fireEvent.keyDown(prompt(), { key: 'Enter', shiftKey: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(0);

      fireEvent.keyDown(prompt(), { key: 'Enter' });
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(1));
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toMatchObject({ prompt: 'A red fox' });
    });

    it('asks for a prompt instead of submitting an empty one', () => {
      const fetchMock = stubApi({});
      renderScreen();
      fireEvent.change(prompt(), { target: { value: '   ' } });
      fireEvent.click(generate());
      expect(screen.getByRole('alert').textContent).toBe('Describe the image you want to create.');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('greets with example prompts that fill the composer', () => {
      const fetchMock = stubApi({});
      renderScreen();
      expect(screen.getByRole('heading', { name: 'What would you like to create?' })).toBeTruthy();
      const examples = within(screen.getByRole('list', { name: 'Example prompts' })).getAllByRole(
        'button',
      );
      expect(examples.map((button) => button.textContent)).toEqual([...EXAMPLE_PROMPTS]);
      fireEvent.click(examples[1]!);
      expect(prompt().value).toBe(EXAMPLE_PROMPTS[1]);
      expect(document.activeElement).toBe(prompt());
      // Filling the composer doesn't send anything.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('options', () => {
    it('shows each style sample straight from /static/, not through the image optimizer', () => {
      const { baseElement } = renderScreen();
      fireEvent.click(screen.getByRole('button', { name: 'Style: None' }));
      const group = screen.getByRole('radiogroup', { name: 'Style' });
      const sources = Array.from(group.querySelectorAll('img'), (img) => img.getAttribute('src'));
      expect(sources).toEqual(SAMPLE_IMAGES.map((sample) => sample.src));
      expect(baseElement.querySelector('img[src^="/_next/image"]')).toBeNull();
      expect(within(group).getAllByRole('radio')).toHaveLength(styles.length);
    });

    it('shows the picked style on its button', () => {
      renderScreen();
      chooseStyle('Watercolour');
      expect(checked(radio('Watercolour'))).toBe(true);
      expect(screen.getByRole('button', { name: 'Style: Watercolour' })).toBeTruthy();
    });

    it('shows the avoid field only for models that take a negative prompt', () => {
      renderScreen();
      openMore();
      expect(screen.queryByRole('textbox', { name: 'Avoid (optional)' })).toBeNull();
      chooseModel(/^Mock/);
      expect(avoidField()).toBeTruthy();
    });

    it('shows the transparent background toggle only for models that support it', () => {
      renderScreen();
      expect(offersExtra('Transparent background')).toBe(true);
      chooseModel(/^Gemini 3 Pro Image/);
      expect(offersExtra('Transparent background')).toBe(false);
    });

    it('sets the suggested model when a style is picked, keeping a quality it offers', () => {
      renderScreen();
      chooseModel(/^GPT Image 2/);
      chooseStyle('Photorealistic');
      expect(modelButton().getAttribute('aria-label')).toBe('Model: Gemini 3 Pro Image');
      fireEvent.click(modelButton());
      expect(checked(radio(/^Gemini 3 Pro Image/))).toBe(true);
      expect(screen.getByRole('combobox', { name: 'Quality' }).textContent).toBe('Standard');
      expect(qualityOption(/^Draft/).disabled).toBe(true);
      expect(screen.getByText('Uses 14 of your 25 points today')).toBeTruthy();
      expect(generate().textContent).toBe('Generate · 14 points');
    });

    it('offers every aspect ratio with a shape icon', () => {
      renderScreen();
      const options = openSelect('Aspect ratio');
      expect(options.map((option) => option.textContent)).toEqual([
        '1:1',
        '4:5',
        '3:2',
        '2:3',
        '16:9',
        '9:16',
      ]);
      for (const option of options) {
        expect(option.querySelector('[data-aspect-icon]')).not.toBeNull();
      }
      fireEvent.click(screen.getByRole('option', { name: '16:9' }));
      expect(screen.getByRole('combobox', { name: 'Aspect ratio' }).textContent).toBe('16:9');
    });

    it('lists each model with its strengths and cost per image behind the model button', () => {
      renderScreen();
      expect(screen.queryByRole('radiogroup', { name: 'Model' })).toBeNull();
      fireEvent.click(modelButton());
      const option = radio(/^GPT Image 2/);
      expect(within(option).getByText(/Follows prompts closely/)).toBeTruthy();
      expect(
        within(option).getByText('Draft 1 · Standard 6 · High 22 points per image'),
      ).toBeTruthy();
    });

    it('names the chosen model on its button', () => {
      renderScreen();
      expect(modelButton().textContent).toBe('Auto · GPT Image 2');
      chooseModel(/^Gemini 3 Pro Image/);
      expect(modelButton().textContent).toBe('Gemini 3 Pro Image');
    });

    it('offers one image or up to four variations, each with its points', () => {
      renderScreen();
      const variations = screen.getByRole('combobox', { name: 'Variations' });
      expect(variations.textContent).toBe('1 image');
      expect(openSelect('Variations').map((option) => option.textContent)).toEqual([
        '1 image6 points',
        '2 variations12 points',
        '3 variations18 points',
        '4 variations24 points',
      ]);
      fireEvent.click(screen.getByRole('option', { name: /^3 variations/ }));
      expect(variations.textContent).toBe('3 variations');
    });
  });

  describe('cost', () => {
    it('shows what the request uses of the points left, following quality and count', () => {
      renderScreen({ left: 20, limit: 25 });
      expect(screen.getByText('Uses 6 of your 20 points today')).toBeTruthy();
      expect(qualityOption(/^High/).text).toContain('22 points per image');
      chooseOption('Quality', /^Draft/);
      chooseCount(4);
      expect(screen.getByText('Uses 4 of your 20 points today')).toBeTruthy();
    });

    it("disables generate when the user can't afford the request", () => {
      renderScreen({ left: 5, limit: 25 });
      chooseModel(/^GPT Image 2/);
      expect(generate().disabled).toBe(true);
      expect(screen.getByText(/don't have enough points left today/)).toBeTruthy();
      chooseOption('Quality', /^Draft/);
      expect(generate().disabled).toBe(false);
      expect(screen.queryByText(/don't have enough points left today/)).toBeNull();
    });
  });

  describe('deliver later (batch)', () => {
    const later = () => extraToggle('Save points: deliver later');

    it('offers to save points under More, halving the cost, and explains the wait', () => {
      renderScreen({ left: 20, limit: 25 });
      // By hand, so the prices don't follow Auto routing.
      chooseModel(/^GPT Image 2/);
      expect(screen.getByText('Uses 6 of your 20 points today')).toBeTruthy();
      expect(pressed(later())).toBe(false);
      // The explanation is read out with the toggle.
      const hint = screen.getByText(
        /Half the points\. Your images arrive in your gallery within 24 hours/,
      );
      expect(later().getAttribute('aria-describedby')).toBe(hint.id);

      fireEvent.click(later());
      expect(pressed(later())).toBe(true);
      expect(
        screen.getByText('Uses 3 of your 20 points today (half of 6, delivered later)'),
      ).toBeTruthy();
      expect(schedule().textContent).toBe('Schedule · 3 points');
      chooseOption('Quality', /^High/);
      // 22 points, half rounded up.
      expect(screen.getByText(/^Uses 11 of your 20 points today/)).toBeTruthy();
      // The variations show the halved cost too.
      expect(openSelect('Variations').map((option) => option.textContent)).toContain(
        '2 variations22 points',
      );
    });

    it('lets a batch fit where the full price would not', () => {
      renderScreen({ left: 5, limit: 25 });
      chooseModel(/^GPT Image 2/);
      expect(generate().disabled).toBe(true);
      fireEvent.click(later());
      expect(schedule().disabled).toBe(false);
    });

    it('hides the option for a model without batches', () => {
      renderScreen();
      chooseModel(/^Stable Image Core/);
      expect(offersExtra('Save points: deliver later')).toBe(false);
    });

    it('schedules the job, keeps the form open, and notifies when the images are ready', async () => {
      const shown: { title: string; options?: NotificationOptions }[] = [];
      class FakeNotification {
        static permission: NotificationPermission = 'default';
        static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
        constructor(title: string, options?: NotificationOptions) {
          shown.push({ title, options });
        }
      }
      vi.stubGlobal('Notification', FakeNotification);
      let ready = false;
      const fetchMock = stubApi({
        created: json({ jobId: JOB_ID, status: 'scheduled', pointsReserved: 3 }, 202),
        me: { pointsLeft: 22 },
      });
      const images = [
        { imageId: 'IMG1', version: 1, url: 'https://signed.example/IMG1.png', downloadUrl: 'd' },
      ];
      const statusOf = () =>
        ready
          ? { status: 'succeeded', pointsReserved: 3, pointsCharged: 3, images }
          : { status: 'submitted', pointsReserved: 3 };
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/jobs' && init?.method === 'POST') {
          return json({ jobId: JOB_ID, status: 'scheduled', pointsReserved: 3 }, 202);
        }
        if (url === `/api/jobs/${JOB_ID}`) return json({ jobId: JOB_ID, ...statusOf() });
        if (url === '/api/me') return json({ pointsLeft: 22, dailyLimit: 25 });
        if (url === '/api/enhance') {
          const body = JSON.parse(init?.body as string) as { prompt: string };
          return json({ enhancedPrompt: body.prompt });
        }
        return json({}, 404);
      });
      renderScreen({ left: 25, limit: 25 });
      fireEvent.click(later());
      fireEvent.change(prompt(), { target: { value: 'A lighthouse at dusk' } });
      fireEvent.click(schedule());

      expect(await screen.findByText('Status: Scheduled')).toBeTruthy();
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toMatchObject({ delivery: 'batch' });
      expect(screen.getByText(/often much sooner\. You can leave this page\./)).toBeTruthy();
      // The form stays open for another request.
      expect(schedule().disabled).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: "Notify me when they're ready" }));
      expect(
        await screen.findByText(/We'll notify you here when your images are ready/),
      ).toBeTruthy();
      expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();

      ready = true;
      expect(await screen.findByText('Status: Done')).toBeTruthy();
      await waitFor(() => expect(shown).toHaveLength(1));
      expect(shown[0]).toEqual({
        title: 'Your Pictora images are ready',
        options: { body: 'A lighthouse at dusk', tag: 'pictora-batch' },
      });
      expect(screen.getAllByRole('img', { name: 'A lighthouse at dusk' })).toHaveLength(1);
    });

    it('hides the notification offer when the browser blocks notifications', async () => {
      vi.stubGlobal(
        'Notification',
        class {
          static permission: NotificationPermission = 'denied';
        },
      );
      const fetchMock = stubApi({
        created: json({ jobId: JOB_ID, status: 'scheduled', pointsReserved: 3 }, 202),
        statuses: [{ status: 'scheduled' }],
      });
      renderScreen();
      fireEvent.click(later());
      fireEvent.change(prompt(), { target: { value: 'A lighthouse at dusk' } });
      fireEvent.click(schedule());
      expect(await screen.findByText('Status: Scheduled')).toBeTruthy();
      expect(fetchMock).toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: "Notify me when they're ready" })).toBeNull();
    });
  });

  describe('job', () => {
    const images = [1, 2].map((n) => ({
      imageId: `IMG${n}`,
      version: 1,
      url: `https://signed.example/IMG${n}.png`,
      downloadUrl: `https://signed.example/IMG${n}.png?download`,
    }));

    it('sends the request, follows the status to done and shows the results', async () => {
      const fetchMock = stubApi({
        statuses: [
          { status: 'queued' },
          { status: 'running' },
          { status: 'succeeded', pointsCharged: 2, images },
        ],
        me: { pointsLeft: 23 },
      });
      const imagesChanged = vi.fn();
      window.addEventListener(IMAGES_CHANGED_EVENT, imagesChanged);
      renderScreen();
      chooseModel(/^Mock/);
      chooseOption('Quality', /^Draft/);
      chooseCount(2);
      fireEvent.change(avoidField(), { target: { value: 'blur' } });
      fillAndGenerate('  A lighthouse at dusk ');

      await screen.findByText('Status: Queued');
      expect(screen.getByText('23 of 25 points left today')).toBeTruthy();
      expect(screen.getByText(/You can leave this page/)).toBeTruthy();
      expect(generate().disabled).toBe(true);
      const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/jobs')!;
      expect(JSON.parse(init!.body as string)).toEqual({
        type: 'generate',
        prompt: 'A lighthouse at dusk',
        avoid: 'blur',
        style: 'none',
        modelId: 'mock',
        aspect: '1:1',
        quality: 'draft',
        count: 2,
      });

      await screen.findByText('Status: Done');
      const results = screen.getByRole('list', { name: 'Results' });
      const downloads = within(results).getAllByRole('link', { name: 'Download PNG' });
      // Downloads go through the app, which counts them for the keep rate.
      expect(downloads.map((link) => link.getAttribute('href'))).toEqual(
        images.map((image) => `/api/images/${image.imageId}/versions/${image.version}/download`),
      );
      expect(downloads[0]?.hasAttribute('download')).toBe(true);
      expect(within(results).getAllByRole('img', { name: 'A lighthouse at dusk' })).toHaveLength(2);
      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([url]) => url === '/api/me')).toHaveLength(1),
      );
      expect(screen.getByText('23 of 25 points left today')).toBeTruthy();
      expect(generate().disabled).toBe(false);
      expect(screen.queryByText(/You can leave this page/)).toBeNull();
      // The sidebar history and points refresh.
      expect(imagesChanged).toHaveBeenCalledOnce();
      window.removeEventListener(IMAGES_CHANGED_EVENT, imagesChanged);
    });

    it('opens a full-size view with a download, closed with Escape', async () => {
      stubApi({ statuses: [{ status: 'succeeded', pointsCharged: 6, images }] });
      renderScreen();
      fillAndGenerate();
      fireEvent.click(await screen.findByRole('button', { name: 'View image 2 full size' }));
      const dialog = screen.getByRole('dialog', { name: 'Full-size image' });
      expect(within(dialog).getByRole('img').getAttribute('src')).toBe(images[1]?.url);
      expect(within(dialog).getByRole('link', { name: 'Download PNG' }).getAttribute('href')).toBe(
        `/api/images/${images[1]?.imageId}/versions/1/download`,
      );
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('reports an image from the full-size view', async () => {
      const fetchMock = stubApi({ statuses: [{ status: 'succeeded', pointsCharged: 6, images }] });
      renderScreen();
      fillAndGenerate();
      fireEvent.click(await screen.findByRole('button', { name: 'View image 2 full size' }));
      const dialog = screen.getByRole('dialog', { name: 'Full-size image' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }));
      // The report dialog opens over the full-size view.
      const report = screen.getByRole('dialog', { name: 'Report this image' });
      fireEvent.click(within(report).getByRole('radio', { name: 'Hate or harassment' }));
      fireEvent.click(within(report).getByRole('button', { name: 'Send report' }));
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageId: 'IMG2', version: 1, reason: 'hate' }),
        }),
      );
    });

    it('shows a plain-language reason and the refund when the job fails', async () => {
      stubApi({
        statuses: [
          { status: 'running' },
          { status: 'failed', pointsCharged: 0, error: 'The image service took too long.' },
        ],
        me: { pointsLeft: 25 },
      });
      renderScreen();
      chooseOption('Quality', /^Draft/);
      fillAndGenerate();
      await screen.findByText('Status: Failed');
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('The image service took too long.');
      expect(alert.textContent).toContain('2 points returned to your allowance.');
      await screen.findByText('25 of 25 points left today');
    });

    it('labels a blocked job as blocked', async () => {
      stubApi({
        statuses: [{ status: 'blocked', error: "This request can't be created." }],
      });
      renderScreen();
      fillAndGenerate();
      await screen.findByText('Status: Blocked');
      expect(screen.getByRole('alert').textContent).toContain("This request can't be created.");
    });

    it('shows the error when the job is refused, and refreshes the points', async () => {
      const fetchMock = stubApi({
        created: json({ code: 'out_of_points', error: 'This request needs 6 points.' }, 402),
      });
      renderScreen();
      fillAndGenerate();
      expect((await screen.findByRole('alert')).textContent).toBe('This request needs 6 points.');
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me', { cache: 'no-store' }));
      expect(screen.queryByText(/Status:/)).toBeNull();
    });

    it('stops polling after the timeout and says the results will be in the gallery', async () => {
      const fetchMock = stubApi({ statuses: [{ status: 'running' }] });
      renderScreen(undefined, 40);
      fillAndGenerate();
      await screen.findByText(/taking longer than usual/);
      const polls = fetchMock.mock.calls.filter(([url]) => url === `/api/jobs/${JOB_ID}`).length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetchMock.mock.calls.filter(([url]) => url === `/api/jobs/${JOB_ID}`)).toHaveLength(
        polls,
      );
      expect(generate().disabled).toBe(false);
    });

    it('links to the gallery while the job runs, and each result to its edit panel', async () => {
      stubApi({ statuses: [{ status: 'queued' }, { status: 'succeeded', images }] });
      renderScreen();
      fillAndGenerate();
      const gallery = await screen.findByRole('link', { name: 'gallery' });
      expect(gallery.getAttribute('href')).toBe('/gallery');

      await screen.findByText('Status: Done');
      expect(
        screen.getAllByRole('link', { name: 'Edit' }).map((link) => link.getAttribute('href')),
      ).toEqual(['/edit/IMG1?version=1', '/edit/IMG2?version=1']);
    });
  });

  describe('thread', () => {
    const imageOf = (n: number) => ({
      imageId: `IMG${n}`,
      version: 1,
      url: `https://signed.example/IMG${n}.png`,
      downloadUrl: `https://signed.example/IMG${n}.png?download`,
    });

    it('keeps each request and its results in the thread, newest last', async () => {
      let polls = 0;
      const fetchMock = stubApi({});
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/jobs' && init?.method === 'POST') {
          const n = bodiesOf(fetchMock, '/api/jobs').length;
          return json({ jobId: jobIdFor(n), status: 'queued', pointsReserved: 2 }, 202);
        }
        if (url.startsWith('/api/jobs/')) {
          polls += 1;
          const n = url.endsWith(JOB_ID) ? 1 : 2;
          return json({
            jobId: url.slice('/api/jobs/'.length),
            pointsReserved: 2,
            pointsCharged: 2,
            status: 'succeeded',
            images: [imageOf(n)],
          });
        }
        if (url === '/api/me') return json({ pointsLeft: 21, dailyLimit: 25 });
        return json({}, 404);
      });
      const imagesChanged = vi.fn();
      window.addEventListener(IMAGES_CHANGED_EVENT, imagesChanged);
      renderScreen();
      fireEvent.click(toggleButton('Enhance prompt'));
      chooseModel(/^Mock/);
      chooseOption('Quality', /^Draft/);
      fillAndGenerate('A red fox');
      await screen.findByText('Status: Done');
      // The greeting gives way to the thread.
      expect(screen.queryByRole('list', { name: 'Example prompts' })).toBeNull();

      chooseStyle('Watercolour');
      chooseCount(2);
      fillAndGenerate('A blue whale');
      await waitFor(() => expect(screen.getAllByText('Status: Done')).toHaveLength(2));

      const turns = threadTurns();
      expect(turns).toHaveLength(2);
      expect(within(turns[0]!).getByText('A red fox')).toBeTruthy();
      // The options read as one line, not a row of chips.
      expect(within(turns[0]!).queryByRole('list', { name: 'Options' })).toBeNull();
      expect(
        within(turns[0]!).getByText('No style · 1:1 · Draft · 1 image · Mock (dev only)'),
      ).toBeTruthy();
      expect(within(turns[0]!).getByRole('img', { name: 'A red fox' }).getAttribute('src')).toBe(
        imageOf(1).url,
      );
      expect(within(turns[1]!).getByText('A blue whale')).toBeTruthy();
      // Watercolour selects its suggested model (GEN-5).
      expect(
        within(turns[1]!).getByText(/^Watercolour · 1:1 · \w+ · 2 variations · .+$/),
      ).toBeTruthy();
      expect(within(turns[1]!).getByRole('img', { name: 'A blue whale' }).getAttribute('src')).toBe(
        imageOf(2).url,
      );
      expect(polls).toBeGreaterThanOrEqual(2);
      // Each finished job refreshes the sidebar history and the points.
      expect(imagesChanged).toHaveBeenCalledTimes(2);
      await screen.findByText('21 of 25 points left today');
      window.removeEventListener(IMAGES_CHANGED_EVENT, imagesChanged);
    });

    it('blocks a new request while the latest job runs, and opens again when it ends', async () => {
      let done = false;
      const fetchMock = stubApi({});
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/jobs' && init?.method === 'POST') {
          return json({ jobId: JOB_ID, status: 'queued', pointsReserved: 2 }, 202);
        }
        if (url.startsWith('/api/jobs/')) {
          return json(
            done
              ? { jobId: JOB_ID, status: 'failed', pointsReserved: 2, pointsCharged: 0 }
              : { jobId: JOB_ID, status: 'running', pointsReserved: 2 },
          );
        }
        if (url === '/api/me') return json({ pointsLeft: 25, dailyLimit: 25 });
        return json({}, 404);
      });
      renderScreen();
      fireEvent.click(toggleButton('Enhance prompt'));
      fillAndGenerate('A red fox');
      await screen.findByText('Status: Generating');
      expect(generate().textContent).toBe('Generating…');
      expect(generate().disabled).toBe(true);
      // Enter doesn't start a second job either.
      fireEvent.keyDown(prompt(), { key: 'Enter' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(1);

      done = true;
      await screen.findByText('Status: Failed');
      await waitFor(() => expect(generate().disabled).toBe(false));
      expect(generate().textContent).toMatch(/^Generate · \d+ points?$/);
    });

    it('keeps the rarer options behind Details', async () => {
      stubApi({ statuses: [{ status: 'queued' }] });
      renderScreen();
      fireEvent.click(toggleButton('Enhance prompt'));
      chooseModel(/^Mock/);
      fireEvent.change(avoidField(), { target: { value: 'blur' } });
      fillAndGenerate('A red fox');
      await screen.findByText('Status: Queued');

      const [turn] = threadTurns();
      const details = within(turn!).getByRole('button', { name: 'Details' });
      expect(details.getAttribute('aria-expanded')).toBe('false');
      const extras = within(turn!).getByText('Avoid: blur');
      expect(extras.hidden).toBe(true);
      fireEvent.click(details);
      expect(details.getAttribute('aria-expanded')).toBe('true');
      expect(details.textContent).toBe('Hide details');
      expect(extras.hidden).toBe(false);
    });

    it('has no Details when a request used no extras', async () => {
      stubApi({ statuses: [{ status: 'queued' }] });
      renderScreen();
      fireEvent.click(toggleButton('Enhance prompt'));
      fillAndGenerate('A red fox');
      await screen.findByText('Status: Queued');
      expect(within(threadTurns()[0]!).queryByRole('button', { name: 'Details' })).toBeNull();
    });
  });

  describe('more variations', () => {
    const images = [
      { imageId: 'IMG1', version: 1, url: 'https://signed.example/IMG1.png', downloadUrl: 'd' },
    ];

    it('sends the request again on the model Auto picked, and adds a turn', async () => {
      const fetchMock = stubApi({
        created: (n) =>
          json(
            {
              jobId: jobIdFor(n),
              status: 'queued',
              pointsReserved: 7,
              modelId: 'gemini-3.1-flash-image',
            },
            202,
          ),
        statuses: [{ status: 'succeeded', pointsCharged: 7, images }],
      });
      renderScreen();
      fireEvent.click(toggleButton('Enhance prompt'));
      chooseStyle('Anime');
      chooseCount(2);
      fillAndGenerate('A red fox');
      await screen.findByText('Status: Done');

      const more = within(threadTurns()[0]!).getByRole<HTMLButtonElement>('button', {
        name: 'More variations · 7 points',
      });
      await waitFor(() => expect(more.disabled).toBe(false));
      fireEvent.click(more);
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(2));
      const [first, second] = bodiesOf(fetchMock, '/api/jobs');
      expect(first).toMatchObject({ modelId: 'auto', count: 2 });
      expect(second).toEqual({ ...first, modelId: 'gemini-3.1-flash-image' });
      await waitFor(() => expect(threadTurns()).toHaveLength(2));
      expect(
        within(threadTurns()[1]!).getByText(
          'Anime · 1:1 · Standard · 2 variations · Gemini 3.1 Flash Image',
        ),
      ).toBeTruthy();
    });

    it("leaves out a rerun's seed, so the takes differ", async () => {
      const fetchMock = stubApi({ statuses: [{ status: 'succeeded', pointsCharged: 1, images }] });
      render(
        <GenerateScreen
          models={models}
          styles={styles}
          points={{ left: 25, limit: 25 }}
          rerun={{
            prompt: 'A lighthouse at dusk',
            style: 'none',
            modelId: 'mock',
            quality: 'draft',
            aspect: '1:1',
            seed: 1234,
          }}
          pollIntervalMs={5}
          pollTimeoutMs={2_000}
        />,
      );
      fireEvent.click(generate());
      await screen.findByText('Status: Done');
      const more = screen.getByRole<HTMLButtonElement>('button', { name: /^More variations/ });
      await waitFor(() => expect(more.disabled).toBe(false));
      fireEvent.click(more);
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(2));
      const [first, second] = bodiesOf(fetchMock, '/api/jobs');
      expect(first).toMatchObject({ seed: 1234 });
      expect(second).not.toHaveProperty('seed');
      expect(second).toMatchObject({ prompt: 'A lighthouse at dusk', modelId: 'mock' });
    });

    it("is disabled while another job runs or when the points don't cover it", async () => {
      let polls = 0;
      const fetchMock = stubApi({});
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/jobs' && init?.method === 'POST') {
          const n = bodiesOf(fetchMock, '/api/jobs').length;
          return json({ jobId: jobIdFor(n), status: 'queued', pointsReserved: 2 }, 202);
        }
        if (url.startsWith('/api/jobs/')) {
          polls += 1;
          const first = url.endsWith(JOB_ID);
          return json({
            jobId: url.slice('/api/jobs/'.length),
            pointsReserved: 2,
            ...(first ? { status: 'succeeded', pointsCharged: 2, images } : { status: 'running' }),
          });
        }
        if (url === '/api/me') return json({ pointsLeft: 25, dailyLimit: 25 });
        return json({}, 404);
      });
      renderScreen();
      fireEvent.click(toggleButton('Enhance prompt'));
      fillAndGenerate('A red fox');
      await screen.findByText('Status: Done');
      const more = () =>
        within(threadTurns()[0]!).getByRole<HTMLButtonElement>('button', {
          name: /^More variations/,
        });
      expect(more().disabled).toBe(false);
      fillAndGenerate('A blue whale');
      await screen.findByText('Status: Generating');
      expect(more().disabled).toBe(true);
      expect(polls).toBeGreaterThan(0);
      cleanup();

      stubApi({
        statuses: [{ status: 'succeeded', pointsCharged: 2, images }],
        me: { pointsLeft: 1 },
      });
      renderScreen({ left: 3, limit: 25 });
      fireEvent.click(toggleButton('Enhance prompt'));
      chooseModel(/^Mock/);
      fillAndGenerate('A red fox');
      await screen.findByText('Status: Done');
      await screen.findByText('1 of 25 points left today');
      expect(more().disabled).toBe(true);
    });

    it('is not offered until the job has images', async () => {
      stubApi({ statuses: [{ status: 'failed', pointsCharged: 0, error: 'Took too long.' }] });
      renderScreen();
      fillAndGenerate();
      await screen.findByText('Status: Failed');
      expect(screen.queryByRole('button', { name: /^More variations/ })).toBeNull();
    });
  });

  describe('small screens', () => {
    const sheet = () => screen.getByRole('dialog', { name: 'Image settings' });

    it('folds the settings into a button that opens them in a sheet', () => {
      setMobile(true);
      renderScreen();
      const button = screen.getByRole('button', {
        name: 'Image settings: None · 1:1 · Standard',
      });
      fireEvent.click(button);
      const settings = within(sheet());
      expect(settings.getByRole('button', { name: 'Style: None' })).toBeTruthy();
      expect(settings.getByRole('combobox', { name: 'Aspect ratio' })).toBeTruthy();
      expect(settings.getByRole('combobox', { name: 'Variations' })).toBeTruthy();
      expect(settings.getByRole('button', { name: /^Model: Auto/ })).toBeTruthy();
      // The More options sit in the sheet itself.
      expect(settings.getByRole('button', { name: 'Transparent background' })).toBeTruthy();
      expect(settings.getByRole('button', { name: 'Save points: deliver later' })).toBeTruthy();

      fireEvent.keyDown(settings.getByRole('combobox', { name: 'Quality' }), { key: 'Enter' });
      fireEvent.click(screen.getByRole('option', { name: /^Draft/ }));
      fireEvent.keyDown(settings.getByRole('combobox', { name: 'Variations' }), { key: 'Enter' });
      fireEvent.click(screen.getByRole('option', { name: /^2 variations/ }));
      expect(button.getAttribute('aria-label')).toBe(
        'Image settings: None · 1:1 · Draft · 2 variations',
      );
      // While the sheet is open the page behind it is hidden from assistive tech.
      fireEvent.keyDown(sheet(), { key: 'Escape' });
      expect(generate().textContent).toBe('Generate · 2 points');
    });

    it('sends what was set in the sheet', async () => {
      setMobile(true);
      const fetchMock = stubApi({ statuses: [{ status: 'queued' }] });
      renderScreen();
      fireEvent.click(toggleButton('Enhance prompt'));
      fireEvent.click(screen.getByRole('button', { name: /^Image settings:/ }));
      fireEvent.click(within(sheet()).getByRole('button', { name: 'Transparent background' }));
      fireEvent.keyDown(sheet(), { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: 'Image settings' })).toBeNull();
      fillAndGenerate('A red fox');
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(1));
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toMatchObject({ transparentBackground: true });
    });

    it("doesn't open the sheet on wide screens, where the row shows instead", () => {
      renderScreen();
      fireEvent.click(screen.getByRole('button', { name: /^Image settings:/ }));
      expect(screen.queryByRole('dialog', { name: 'Image settings' })).toBeNull();
    });
  });

  describe('Auto model', () => {
    const autoLine = () => screen.getByText(/^Auto picks/).textContent;

    it('is selected by default and explains the model it picks with the model button', () => {
      renderScreen();
      // The reason is read out with the button, and shown in its tooltip.
      expect(modelButton().getAttribute('aria-describedby')).toBe(
        screen.getByText(/^Auto picks/).id,
      );
      fireEvent.click(modelButton());
      expect(checked(radio(/^Auto \(recommended\)/))).toBe(true);
      expect(checked(radio(/^GPT Image 2/))).toBe(false);
      expect(autoLine()).toBe('Auto picks GPT Image 2: the best fit for your prompt.');

      chooseStyle('Photorealistic');
      expect(autoLine()).toBe('Auto picks Gemini 3 Pro Image: the best fit for Photorealistic.');
      expect(screen.getByText('Uses 14 of your 25 points today')).toBeTruthy();
      expect(qualityOption(/^Standard/).text).toContain('14 points per image');
    });

    it('prefers a text model when the prompt asks for words', () => {
      renderScreen();
      chooseStyle('Watercolour');
      expect(autoLine()).toMatch(/^Auto picks Gemini 3\.1 Flash Image/);
      fireEvent.change(prompt(), { target: { value: 'A poster that says "Summer Fair"' } });
      expect(autoLine()).toBe('Auto picks GPT Image 2: best at words in images.');
    });

    it('picks an affordable model, then a lower quality, when points are low', () => {
      renderScreen({ left: 10, limit: 25 });
      chooseStyle('Photorealistic');
      expect(autoLine()).toBe('Auto picks GPT Image 2: it fits the points you have left.');
      expect(screen.getByText('Uses 6 of your 10 points today')).toBeTruthy();
      cleanup();

      // Even the dev-only mock model costs 2 points at Standard.
      renderScreen({ left: 1, limit: 25 });
      chooseStyle('Photorealistic');
      expect(autoLine()).toBe(
        'Auto picks GPT Image 2: Draft quality fits the points you have left.',
      );
      expect(generate().disabled).toBe(false);
    });

    it('sends auto to the job API and shows the model the server picked', async () => {
      const fetchMock = stubApi({
        created: json(
          { jobId: JOB_ID, status: 'queued', pointsReserved: 7, modelId: 'gemini-3.1-flash-image' },
          202,
        ),
        statuses: [{ status: 'queued', modelId: 'gemini-3.1-flash-image' }],
      });
      renderScreen();
      chooseStyle('Anime');
      fireEvent.click(toggleButton('Enhance prompt'));
      fillAndGenerate();
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(1));
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toMatchObject({
        modelId: 'auto',
        style: 'anime',
        quality: 'standard',
      });
      expect(await screen.findByText('Model: Gemini 3.1 Flash Image')).toBeTruthy();
    });

    it('offers a transparent background and routes to a model that makes one', () => {
      renderScreen();
      chooseStyle('Watercolour');
      fireEvent.click(extraToggle('Transparent background'));
      expect(autoLine()).toMatch(/^Auto picks GPT Image 2/);
    });

    it('goes back to Auto after a model was picked by hand', () => {
      renderScreen();
      chooseModel(/^Gemini 3 Pro Image/);
      expect(screen.queryByText(/^Auto picks/)).toBeNull();
      chooseModel(/^Auto \(recommended\)/);
      expect(autoLine()).toMatch(/^Auto picks GPT Image 2/);
    });
  });

  describe('rerun', () => {
    const RERUN: RerunSettings = {
      prompt: 'A lighthouse at dusk',
      avoid: 'text',
      style: 'watercolour',
      modelId: 'mock',
      quality: 'draft',
      aspect: '16:9',
      seed: 1234,
      transparentBackground: true,
    };

    function renderRerun(rerun: RerunSettings) {
      return render(
        <GenerateScreen
          models={models}
          styles={styles}
          points={{ left: 25, limit: 25 }}
          rerun={rerun}
          pollIntervalMs={5}
          pollTimeoutMs={2_000}
        />,
      );
    }

    it("fills in the original settings and sends the same seed, in the user's own words", async () => {
      const fetchMock = stubApi({ statuses: [{ status: 'queued' }] });
      renderRerun(RERUN);
      expect(prompt().value).toBe('A lighthouse at dusk');
      expect(avoidField().value).toBe('text');
      expect(screen.getByRole('button', { name: 'Style: Watercolour' })).toBeTruthy();
      expect(screen.getByRole('combobox', { name: 'Aspect ratio' }).textContent).toBe('16:9');
      expect(screen.getByRole('combobox', { name: 'Quality' }).textContent).toBe('Draft');
      expect(pressed(toggleButton('Transparent background'))).toBe(true);
      fireEvent.click(modelButton());
      expect(checked(radio(/^Mock/))).toBe(true);
      // The original used the user's own words, so the rerun does too.
      expect(pressed(toggleButton('Enhance prompt'))).toBe(false);
      expect(screen.getByText(/Uses seed 1234 from the original image/)).toBeTruthy();

      fireEvent.click(generate());
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(1));
      expect(bodiesOf(fetchMock, '/api/enhance')).toHaveLength(0);
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toEqual({
        type: 'generate',
        prompt: 'A lighthouse at dusk',
        avoid: 'text',
        style: 'watercolour',
        modelId: 'mock',
        aspect: '16:9',
        quality: 'draft',
        count: 1,
        seed: 1234,
        transparentBackground: true,
      });
    });

    it('reuses the original enhanced prompt without enhancing again', async () => {
      const fetchMock = stubApi({ statuses: [{ status: 'queued' }] });
      renderRerun({ ...RERUN, enhancedPrompt: ENHANCED });
      openEnhanced();
      expect(
        (screen.getByRole('textbox', { name: 'Enhanced prompt' }) as HTMLTextAreaElement).value,
      ).toBe(ENHANCED);
      fireEvent.click(generate());
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(1));
      expect(bodiesOf(fetchMock, '/api/enhance')).toHaveLength(0);
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toMatchObject({ enhancedPrompt: ENHANCED });
    });

    it('drops the seed when asked to, or when another model is chosen', async () => {
      const fetchMock = stubApi({ statuses: [{ status: 'queued' }] });
      renderRerun(RERUN);
      fireEvent.click(screen.getByRole('button', { name: 'Use a random seed' }));
      expect(screen.queryByText(/Uses seed/)).toBeNull();
      fireEvent.click(generate());
      await waitFor(() => expect(bodiesOf(fetchMock, '/api/jobs')).toHaveLength(1));
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).not.toHaveProperty('seed');
      cleanup();

      renderRerun(RERUN);
      chooseModel(/^GPT Image 2/);
      expect(screen.queryByText(/Uses seed/)).toBeNull();
    });

    it("picks another model when the original isn't available any more", () => {
      renderRerun({ ...RERUN, modelId: 'retired-model' });
      expect(screen.getByRole('status').textContent).toMatch(
        /The model this image was made with isn't available any more, so we picked /,
      );
      expect(prompt().value).toBe('A lighthouse at dusk');
      expect(screen.queryByText(/Uses seed/)).toBeNull();
    });
  });

  it('says so when no model is available', () => {
    render(<GenerateScreen models={[]} styles={styles} points={{ left: 25, limit: 25 }} />);
    expect(screen.getByRole('alert').textContent).toMatch(/No image models are available/);
  });
});
