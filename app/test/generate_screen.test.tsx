// @vitest-environment jsdom
import { loadSeedRegistry, modelsForEnvironment, MAX_PROMPT_LENGTH } from '@pictora/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerateScreen, type PointsLeft } from '../src/components/generate_screen';
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
    />,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch stand-in: POST /api/jobs answers `created`, each job poll the next status, /api/me `me`. */
function stubApi(options: {
  created?: Response;
  statuses?: Record<string, unknown>[];
  me?: Record<string, unknown>;
}) {
  const statuses = [...(options.statuses ?? [])];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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

describe('GenerateScreen', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
      expect((radio(/^GPT Image 2/) as HTMLInputElement).checked).toBe(true);
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
      expect((generate() as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/don't have enough points left today/)).toBeTruthy();
      fireEvent.click(radio(/^Draft/));
      expect((generate() as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText(/don't have enough points left today/)).toBeNull();
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
      expect(downloads.map((link) => link.getAttribute('href'))).toEqual(
        images.map((image) => image.downloadUrl),
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
        images[1]?.downloadUrl,
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

    it('shows coming soon for the gallery and edit, linked to their issues', async () => {
      stubApi({ statuses: [{ status: 'queued' }, { status: 'succeeded', images }] });
      renderScreen();
      fillAndGenerate();
      fireEvent.click(await screen.findByRole('button', { name: 'gallery' }));
      let toast = screen.getByText('Gallery coming soon.').closest('.toast') as HTMLElement;
      expect(within(toast).getByRole('link').getAttribute('href')).toMatch(/\/issues\/23$/);

      await screen.findByText('Status: Done');
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
      toast = screen.getByText('Edit coming soon.').closest('.toast') as HTMLElement;
      expect(within(toast).getByRole('link').getAttribute('href')).toMatch(/\/issues\/22$/);
      fireEvent.click(within(toast).getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText('Edit coming soon.')).toBeNull();
    });
  });

  it('says so when no model is available', () => {
    render(<GenerateScreen models={[]} styles={styles} points={{ left: 25, limit: 25 }} />);
    expect(screen.getByRole('alert').textContent).toMatch(/No image models are available/);
  });
});
