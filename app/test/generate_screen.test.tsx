// @vitest-environment jsdom
import { loadSeedRegistry, modelsForEnvironment, MAX_PROMPT_LENGTH } from '@pictora/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENHANCE_STORAGE_KEY,
  GenerateScreen,
  type PointsLeft,
} from '../src/components/generate_screen';
import type { RerunSettings } from '../src/lib/images';
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

/**
 * A fetch stand-in: POST /api/jobs answers `created`, each job poll the next status, /api/me `me`.
 * POST /api/enhance answers `enhance`, or by default returns the prompt unchanged.
 */
function stubApi(options: {
  created?: Response;
  statuses?: Record<string, unknown>[];
  me?: Record<string, unknown>;
  enhance?: (body: { prompt: string; style: string; modelId: string }) => Response;
}) {
  const statuses = [...(options.statuses ?? [])];
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
      return options.created ?? json({ jobId: JOB_ID, status: 'queued', pointsReserved: 2 }, 202);
    }
    if (url === `/api/jobs/${JOB_ID}`) {
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return json({ jobId: JOB_ID, pointsReserved: 2, ...next });
    }
    if (url === '/api/me') return json({ pointsLeft: 25, dailyLimit: 25, ...options.me });
    if (url === '/api/reports') return json({ reportId: 'R1' }, 201);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const prompt = () => screen.getByRole('textbox', { name: 'Describe your image' });
const generate = () => screen.getByRole('button', { name: /Generate|Starting|Generating/ });
const radio = (name: string | RegExp) => screen.getByRole('radio', { name });

function chooseModel(name: string | RegExp) {
  fireEvent.click(screen.getByText('Advanced'));
  fireEvent.click(radio(name));
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
    const toggle = () =>
      screen.getByRole('checkbox', { name: /Enhance prompt/ }) as HTMLInputElement;
    const panel = () => screen.queryByRole('region', { name: 'Enhanced prompt' });
    const enhancedBox = () =>
      screen.getByRole('textbox', { name: 'Enhanced prompt' }) as HTMLTextAreaElement;

    it('is on by default and remembers being turned off', () => {
      renderScreen();
      expect(toggle().checked).toBe(true);
      fireEvent.click(toggle());
      expect(toggle().checked).toBe(false);
      expect(window.localStorage.getItem(ENHANCE_STORAGE_KEY)).toBe('off');
      cleanup();

      renderScreen();
      expect(toggle().checked).toBe(false);
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
      expect(toggle().checked).toBe(false);
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

  describe('form', () => {
    it('shows each style sample straight from /static/, not through the image optimizer', () => {
      const { container } = renderScreen();
      const group = screen.getByRole('group', { name: 'Style' });
      const sources = Array.from(group.querySelectorAll('img'), (img) => img.getAttribute('src'));
      expect(sources).toEqual(SAMPLE_IMAGES.map((sample) => sample.src));
      expect(container.querySelector('img[src^="/_next/image"]')).toBeNull();
    });

    it('limits the prompt to 2,000 characters and counts them', () => {
      renderScreen();
      expect(prompt().getAttribute('maxlength')).toBe(String(MAX_PROMPT_LENGTH));
      expect(screen.getByText('0 / 2000')).toBeTruthy();
      fireEvent.change(prompt(), { target: { value: 'A red fox' } });
      expect(screen.getByText('9 / 2000')).toBeTruthy();
    });

    it('asks for a prompt instead of submitting an empty one', () => {
      const fetchMock = stubApi({});
      renderScreen();
      fireEvent.change(prompt(), { target: { value: '   ' } });
      fireEvent.click(generate());
      expect(screen.getByRole('alert').textContent).toBe('Describe the image you want to create.');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows the avoid field only for models that take a negative prompt', () => {
      renderScreen();
      expect(screen.queryByRole('textbox', { name: /Avoid/ })).toBeNull();
      chooseModel(/^Mock/);
      expect(screen.getByRole('textbox', { name: /Avoid/ })).toBeTruthy();
    });

    it('shows the transparent background toggle only for models that support it', () => {
      renderScreen();
      expect(screen.getByRole('checkbox', { name: 'Transparent background' })).toBeTruthy();
      chooseModel(/^Gemini 3 Pro Image/);
      expect(screen.queryByRole('checkbox', { name: 'Transparent background' })).toBeNull();
    });

    it('sets the suggested model when a style is picked, keeping a quality it offers', () => {
      renderScreen();
      chooseModel(/^GPT Image 2/);
      fireEvent.click(radio('Photorealistic'));
      expect((radio(/^Gemini 3 Pro Image/) as HTMLInputElement).checked).toBe(true);
      expect((radio(/^Standard/) as HTMLInputElement).checked).toBe(true);
      expect((radio(/^Draft/) as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByText('Uses 14 of your 25 points today')).toBeTruthy();
    });

    it('offers every aspect ratio with a shape icon', () => {
      const { container } = renderScreen();
      for (const aspect of ['1:1', '4:5', '3:2', '2:3', '16:9', '9:16']) {
        expect(radio(aspect)).toBeTruthy();
      }
      expect(container.querySelectorAll('.aspect-icon')).toHaveLength(6);
    });

    it('lists each model with its strengths and cost per image behind Advanced', () => {
      renderScreen();
      const details = screen.getByText('Advanced').closest('details') as HTMLDetailsElement;
      expect(details.open).toBe(false);
      const option = radio(/^GPT Image 2/).closest('label') as HTMLElement;
      expect(within(option).getByText(/Follows prompts closely/)).toBeTruthy();
      expect(
        within(option).getByText('Draft 1 · Standard 6 · High 22 points per image'),
      ).toBeTruthy();
    });
  });

  describe('cost', () => {
    it('shows what the request uses of the points left, following quality and count', () => {
      renderScreen({ left: 20, limit: 25 });
      expect(screen.getByText('Uses 6 of your 20 points today')).toBeTruthy();
      expect(radio(/^High/).closest('label')?.textContent).toContain('22 points per image');
      fireEvent.click(radio(/^Draft/));
      fireEvent.change(screen.getByRole('combobox', { name: 'Number of images' }), {
        target: { value: '4' },
      });
      expect(screen.getByText('Uses 4 of your 20 points today')).toBeTruthy();
    });

    it("disables generate when the user can't afford the request", () => {
      renderScreen({ left: 5, limit: 25 });
      chooseModel(/^GPT Image 2/);
      expect((generate() as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/don't have enough points left today/)).toBeTruthy();
      fireEvent.click(radio(/^Draft/));
      expect((generate() as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText(/don't have enough points left today/)).toBeNull();
    });
  });

  describe('deliver later (batch)', () => {
    const later = () => screen.getByRole('checkbox', { name: 'Save points: deliver later' });

    it('offers to save points, halving the cost, and explains the wait', () => {
      renderScreen({ left: 20, limit: 25 });
      expect(screen.getByText('Uses 6 of your 20 points today')).toBeTruthy();
      expect(later().getAttribute('aria-checked')).toBe('false');
      expect(
        screen.getByText(/Half the points\. Your images arrive in your gallery within 24 hours/),
      ).toBeTruthy();

      fireEvent.click(later());
      expect(later().getAttribute('aria-checked')).toBe('true');
      expect(
        screen.getByText('Uses 3 of your 20 points today (half of 6, delivered later)'),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Schedule' })).toBeTruthy();
      fireEvent.click(radio(/^High/));
      // 22 points, half rounded up.
      expect(screen.getByText(/^Uses 11 of your 20 points today/)).toBeTruthy();
    });

    it('lets a batch fit where the full price would not', () => {
      renderScreen({ left: 5, limit: 25 });
      chooseModel(/^GPT Image 2/);
      expect((generate() as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(later());
      expect((screen.getByRole('button', { name: 'Schedule' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    it('hides the option for a model without batches', () => {
      renderScreen();
      chooseModel(/^Stable Image Core/);
      expect(screen.queryByRole('checkbox', { name: 'Save points: deliver later' })).toBeNull();
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
      renderScreen();
      chooseModel(/^Mock/);
      fireEvent.click(radio(/^Draft/));
      fireEvent.change(screen.getByRole('combobox', { name: 'Number of images' }), {
        target: { value: '2' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: /Avoid/ }), {
        target: { value: 'blur' },
      });
      fillAndGenerate('  A lighthouse at dusk ');

      await screen.findByText('Status: Queued');
      expect(screen.getByText('23 of 25 points left today')).toBeTruthy();
      expect(screen.getByText(/You can leave this page/)).toBeTruthy();
      expect((generate() as HTMLButtonElement).disabled).toBe(true);
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
      expect((generate() as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText(/You can leave this page/)).toBeNull();
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
      fireEvent.click(radio(/^Draft/));
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
      expect((generate() as HTMLButtonElement).disabled).toBe(false);
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

  describe('Auto model', () => {
    const autoLine = () => screen.getByText(/^Auto picks/).textContent;

    it('is selected by default and shows the model it picks for the style', () => {
      renderScreen();
      fireEvent.click(screen.getByText('Advanced'));
      expect((radio(/^Auto \(recommended\)/) as HTMLInputElement).checked).toBe(true);
      expect((radio(/^GPT Image 2/) as HTMLInputElement).checked).toBe(false);
      expect(autoLine()).toBe('Auto picks GPT Image 2: the best fit for your prompt.');

      fireEvent.click(radio('Photorealistic'));
      expect(autoLine()).toBe('Auto picks Gemini 3 Pro Image: the best fit for Photorealistic.');
      expect(screen.getByText('Uses 14 of your 25 points today')).toBeTruthy();
      expect(radio(/^Standard/).closest('label')?.textContent).toContain('14 points per image');
    });

    it('prefers a text model when the prompt asks for words', () => {
      renderScreen();
      fireEvent.click(radio('Watercolour'));
      expect(autoLine()).toMatch(/^Auto picks Gemini 3\.1 Flash Image/);
      fireEvent.change(prompt(), { target: { value: 'A poster that says "Summer Fair"' } });
      expect(autoLine()).toBe('Auto picks GPT Image 2: best at words in images.');
    });

    it('picks an affordable model, then a lower quality, when points are low', () => {
      renderScreen({ left: 10, limit: 25 });
      fireEvent.click(radio('Photorealistic'));
      expect(autoLine()).toBe('Auto picks GPT Image 2: it fits the points you have left.');
      expect(screen.getByText('Uses 6 of your 10 points today')).toBeTruthy();
      cleanup();

      // Even the dev-only mock model costs 2 points at Standard.
      renderScreen({ left: 1, limit: 25 });
      fireEvent.click(radio('Photorealistic'));
      expect(autoLine()).toBe(
        'Auto picks GPT Image 2: Draft quality fits the points you have left.',
      );
      expect((generate() as HTMLButtonElement).disabled).toBe(false);
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
      fireEvent.click(radio('Anime'));
      fireEvent.click(screen.getByRole('checkbox', { name: /Enhance prompt/ }));
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
      fireEvent.click(radio('Watercolour'));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Transparent background' }));
      expect(autoLine()).toMatch(/^Auto picks GPT Image 2/);
    });

    it('goes back to Auto after a model was picked by hand', () => {
      renderScreen();
      chooseModel(/^Gemini 3 Pro Image/);
      expect(screen.queryByText(/^Auto picks/)).toBeNull();
      fireEvent.click(radio(/^Auto \(recommended\)/));
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
      expect((prompt() as HTMLTextAreaElement).value).toBe('A lighthouse at dusk');
      expect(
        (screen.getByRole('textbox', { name: 'Avoid (optional)' }) as HTMLInputElement).value,
      ).toBe('text');
      expect((radio('Watercolour') as HTMLInputElement).checked).toBe(true);
      expect((radio('16:9') as HTMLInputElement).checked).toBe(true);
      expect((radio(/^Draft/) as HTMLInputElement).checked).toBe(true);
      expect((radio(/^Mock/) as HTMLInputElement).checked).toBe(true);
      expect(
        (screen.getByRole('checkbox', { name: 'Transparent background' }) as HTMLInputElement)
          .checked,
      ).toBe(true);
      // The original used the user's own words, so the rerun does too.
      expect(
        (screen.getByRole('checkbox', { name: /Enhance prompt/ }) as HTMLInputElement).checked,
      ).toBe(false);
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
      expect((prompt() as HTMLTextAreaElement).value).toBe('A lighthouse at dusk');
      expect(screen.queryByText(/Uses seed/)).toBeNull();
    });
  });

  it('says so when no model is available', () => {
    render(<GenerateScreen models={[]} styles={styles} points={{ left: 25, limit: 25 }} />);
    expect(screen.getByRole('alert').textContent).toMatch(/No image models are available/);
  });
});
