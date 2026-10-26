// @vitest-environment jsdom
import { loadSeedRegistry, modelsForEnvironment, MAX_PROMPT_LENGTH } from '@pictora/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENHANCE_STORAGE_KEY,
  EXAMPLE_PROMPTS,
  GenerateScreen,
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
  created?: Response;
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

const prompt = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Describe your image' });
const generate = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: /^(Generate|Starting|Generating)/ });
const radio = (name: string | RegExp) => screen.getByRole('radio', { name });
const checked = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true';
const pressed = (element: HTMLElement) => element.getAttribute('aria-pressed') === 'true';
const toggleButton = (name: string) => screen.getByRole('button', { name });

/** Opens the Advanced popover and picks a model, or Auto. */
function chooseModel(name: string | RegExp) {
  if (!screen.queryByRole('radiogroup', { name: 'Model' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  }
  fireEvent.click(radio(name));
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

function chooseCount(count: number) {
  fireEvent.click(radio(`${count} ${count === 1 ? 'image' : 'images'}`));
}

/** Opens the Avoid popover and returns its field. */
function avoidField(): HTMLInputElement {
  if (!screen.queryByRole('textbox', { name: 'Avoid (optional)' })) {
    fireEvent.click(screen.getByRole('button', { name: /^Avoid/ }));
  }
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Avoid (optional)' });
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
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  describe('prompt enhancer', () => {
    const toggle = () => toggleButton('Enhance prompt');
    const panel = () => screen.queryByRole('region', { name: 'Enhanced prompt' });
    const enhancedBox = () =>
      screen.getByRole('textbox', { name: 'Enhanced prompt' }) as HTMLTextAreaElement;

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
      expect(panel()).toBeTruthy();
      expect(enhancedBox().value).toBe(ENHANCED);
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

    it('limits the prompt to 2,000 characters and counts them', () => {
      renderScreen();
      expect(prompt().getAttribute('maxlength')).toBe(String(MAX_PROMPT_LENGTH));
      expect(screen.getByText('0 / 2000')).toBeTruthy();
      fireEvent.change(prompt(), { target: { value: 'A red fox' } });
      expect(screen.getByText('9 / 2000')).toBeTruthy();
      fireEvent.change(prompt(), { target: { value: 'x'.repeat(MAX_PROMPT_LENGTH) } });
      expect(screen.getByText('2000 / 2000')).toBeTruthy();
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
      expect(screen.queryByRole('button', { name: /^Avoid/ })).toBeNull();
      chooseModel(/^Mock/);
      expect(avoidField()).toBeTruthy();
    });

    it('shows the transparent background toggle only for models that support it', () => {
      renderScreen();
      expect(toggleButton('Transparent background')).toBeTruthy();
      chooseModel(/^Gemini 3 Pro Image/);
      expect(screen.queryByRole('button', { name: 'Transparent background' })).toBeNull();
    });

    it('sets the suggested model when a style is picked, keeping a quality it offers', () => {
      renderScreen();
      chooseModel(/^GPT Image 2/);
      chooseStyle('Photorealistic');
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
      expect(checked(radio(/^Gemini 3 Pro Image/))).toBe(true);
      expect(screen.getByRole('combobox', { name: 'Quality' }).textContent).toBe('Standard');
      expect(qualityOption(/^Draft/).disabled).toBe(true);
      expect(screen.getByText('Uses 14 of your 25 points today')).toBeTruthy();
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

    it('lists each model with its strengths and cost per image behind Advanced', () => {
      renderScreen();
      expect(screen.queryByRole('radiogroup', { name: 'Model' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
      const option = radio(/^GPT Image 2/);
      expect(within(option).getByText(/Follows prompts closely/)).toBeTruthy();
      expect(
        within(option).getByText('Draft 1 · Standard 6 · High 22 points per image'),
      ).toBeTruthy();
    });

    it('picks one to four images', () => {
      renderScreen();
      const group = screen.getByRole('radiogroup', { name: 'Number of images' });
      expect(
        within(group)
          .getAllByRole('radio')
          .map((item) => item.textContent),
      ).toEqual(['1', '2', '3', '4']);
      expect(checked(radio('1 image'))).toBe(true);
      chooseCount(3);
      expect(checked(radio('3 images'))).toBe(true);
      expect(checked(radio('1 image'))).toBe(false);
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
    const later = () => toggleButton('Save points: deliver later');

    it('offers to save points, halving the cost, and explains the wait', () => {
      renderScreen({ left: 20, limit: 25 });
      expect(screen.getByText('Uses 6 of your 20 points today')).toBeTruthy();
      expect(pressed(later())).toBe(false);
      // The explanation is read out with the toggle, and shown once it is on.
      const hint = screen.getByText(
        /Half the points\. Your images arrive in your gallery within 24 hours/,
      );
      expect(later().getAttribute('aria-describedby')).toBe(hint.id);
      expect(hint.className).toBe('sr-only');

      fireEvent.click(later());
      expect(pressed(later())).toBe(true);
      expect(hint.className).not.toBe('sr-only');
      expect(
        screen.getByText('Uses 3 of your 20 points today (half of 6, delivered later)'),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Schedule' })).toBeTruthy();
      chooseOption('Quality', /^High/);
      // 22 points, half rounded up.
      expect(screen.getByText(/^Uses 11 of your 20 points today/)).toBeTruthy();
    });

    it('lets a batch fit where the full price would not', () => {
      renderScreen({ left: 5, limit: 25 });
      chooseModel(/^GPT Image 2/);
      expect(generate().disabled).toBe(true);
      fireEvent.click(later());
      expect((screen.getByRole('button', { name: 'Schedule' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    it('hides the option for a model without batches', () => {
      renderScreen();
      chooseModel(/^Stable Image Core/);
      expect(screen.queryByRole('button', { name: 'Save points: deliver later' })).toBeNull();
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
      fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

      expect(await screen.findByText('Status: Scheduled')).toBeTruthy();
      expect(bodiesOf(fetchMock, '/api/jobs')[0]).toMatchObject({ delivery: 'batch' });
      expect(screen.getByText(/often much sooner\. You can leave this page\./)).toBeTruthy();
      // The form stays open for another request.
      expect((screen.getByRole('button', { name: 'Schedule' }) as HTMLButtonElement).disabled).toBe(
        false,
      );

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
      fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
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
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Hate or harassment' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
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

      const turns = within(screen.getByRole('list', { name: 'Your requests' }))
        .getAllByRole('listitem')
        .filter((item) => item.parentElement?.getAttribute('aria-label') === 'Your requests');
      expect(turns).toHaveLength(2);
      expect(within(turns[0]!).getByText('A red fox')).toBeTruthy();
      expect(
        within(within(turns[0]!).getByRole('list', { name: 'Options' }))
          .getAllByRole('listitem')
          .map((chip) => chip.textContent),
      ).toEqual(['No style', '1:1', 'Draft', '1 image', 'Mock (dev only)']);
      expect(within(turns[0]!).getByRole('img', { name: 'A red fox' }).getAttribute('src')).toBe(
        imageOf(1).url,
      );
      expect(within(turns[1]!).getByText('A blue whale')).toBeTruthy();
      expect(within(turns[1]!).getByText('Watercolour')).toBeTruthy();
      expect(within(turns[1]!).getByText('2 images')).toBeTruthy();
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
      expect(generate().textContent).toBe('Generate');
    });
  });

  describe('Auto model', () => {
    const autoLine = () => screen.getByText(/^Auto picks/).textContent;

    it('is selected by default and shows the model it picks for the style', () => {
      renderScreen();
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
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
      fireEvent.click(toggleButton('Transparent background'));
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
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
      expect(checked(radio(/^Mock/))).toBe(true);
      expect(pressed(toggleButton('Transparent background'))).toBe(true);
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
