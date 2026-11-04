// @vitest-environment jsdom
import {
  APP_GENERATE_DEFAULTS,
  loadSeedRegistry,
  modelsForEnvironment,
  type GenerateDefaults,
} from '@pictora/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerateDefaultsCard } from '../src/components/generate_defaults_card';
import { modelsResponse } from '../src/lib/models_response';

const { models, styles } = modelsResponse(modelsForEnvironment(loadSeedRegistry(), 'dev'));

function renderCard(defaults: GenerateDefaults = APP_GENERATE_DEFAULTS, saved = false) {
  return render(
    <GenerateDefaultsCard models={models} styles={styles} defaults={defaults} saved={saved} />,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answers PUT with what was sent, and DELETE with the app defaults, unless `answer` says otherwise. */
function stubApi(answer?: () => Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (answer) return answer();
    if (init?.method === 'PUT') {
      return json({ defaults: JSON.parse(init.body as string) as unknown, saved: true });
    }
    return json({ defaults: APP_GENERATE_DEFAULTS, saved: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const select = (name: string) => screen.getByRole('combobox', { name });
const switchFor = (name: string) => screen.getByRole('switch', { name });
const queryControl = (role: 'switch' | 'textbox', name: string) =>
  screen.queryByRole(role, { name });
const save = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: /^(Save defaults|Saving)/ });
const reset = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Reset to app defaults' });

/** Picks an option in one of the card's selects, opening it from the keyboard as Radix does in jsdom. */
function choose(label: string, option: string | RegExp) {
  fireEvent.keyDown(select(label), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('GenerateDefaultsCard (GEN-11)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the app defaults with every option, and nothing to save or reset yet', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'Defaults' })).toBeTruthy();
    expect(select('Style').textContent).toBe('None');
    expect(select('Model').textContent).toBe('Auto (recommended)');
    expect(select('Aspect ratio').textContent).toContain('1:1');
    expect(select('Quality').textContent).toBe('Standard');
    expect(select('Variations').textContent).toBe('1 image');
    expect(switchFor('Enhance prompt').getAttribute('aria-checked')).toBe('true');
    // With Auto, an option any model offers is shown.
    expect(switchFor('Transparent background').getAttribute('aria-checked')).toBe('false');
    expect(switchFor('Save points: deliver later')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Avoid (optional)' })).toBeTruthy();
    expect(save().disabled).toBe(true);
    expect(reset().disabled).toBe(true);
  });

  it('shows only what the chosen model offers, keeping the quality it has', () => {
    renderCard();
    choose('Model', 'GPT Image 1 Mini');
    expect(switchFor('Transparent background')).toBeTruthy();
    expect(queryControl('textbox', 'Avoid (optional)')).toBeNull();

    // GPT Image 2 can't make a transparent background (#177).
    choose('Model', 'GPT Image 2');
    expect(queryControl('switch', 'Transparent background')).toBeNull();

    choose('Model', 'SD 3.5 Large');
    expect(queryControl('switch', 'Transparent background')).toBeNull();
    expect(queryControl('switch', 'Save points: deliver later')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Avoid (optional)' })).toBeTruthy();
    expect(select('Quality').textContent).toBe('Standard');
    fireEvent.keyDown(select('Quality'), { key: 'Enter' });
    expect(screen.getByRole('option', { name: /^High/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('saves every option, leaving out what the model does not offer', async () => {
    const fetchMock = stubApi();
    renderCard();
    choose('Style', 'Watercolour');
    choose('Model', 'Mock (dev only)');
    choose('Aspect ratio', /16:9/);
    choose('Quality', /^High/);
    choose('Variations', /^3 variations/);
    fireEvent.click(switchFor('Transparent background'));
    fireEvent.click(switchFor('Save points: deliver later'));
    fireEvent.click(switchFor('Enhance prompt'));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());

    await screen.findByText('Defaults saved. New images start with them.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/defaults',
      expect.objectContaining({ method: 'PUT' }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as GenerateDefaults;
    expect(body).toEqual({
      style: 'watercolour',
      modelId: 'mock',
      aspect: '16:9',
      quality: 'high',
      count: 3,
      transparentBackground: true,
      deliverLater: true,
      avoid: '',
      enhance: false,
    });
    expect(save().disabled).toBe(true);
    expect(reset().disabled).toBe(false);
  });

  it('switches off an option the newly chosen model does not offer before saving', async () => {
    const fetchMock = stubApi();
    renderCard();
    fireEvent.click(switchFor('Transparent background'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Avoid (optional)' }), {
      target: { value: '  blur ' },
    });
    choose('Model', 'Gemini 3.1 Flash Image');
    fireEvent.click(save());
    await screen.findByText(/Defaults saved/);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      modelId: 'gemini-3.1-flash-image',
      transparentBackground: false,
      avoid: '',
    });
  });

  it('resets saved defaults to the app defaults', async () => {
    const fetchMock = stubApi();
    renderCard({ ...APP_GENERATE_DEFAULTS, style: 'anime', count: 4 }, true);
    expect(select('Style').textContent).toBe('Anime');
    fireEvent.click(reset());
    await screen.findByText('Defaults reset to the app defaults.');
    expect(fetchMock).toHaveBeenCalledWith('/api/me/defaults', { method: 'DELETE' });
    expect(select('Style').textContent).toBe('None');
    expect(select('Variations').textContent).toBe('1 image');
    expect(reset().disabled).toBe(true);
  });

  it('shows the error and keeps the changes when saving fails', async () => {
    stubApi(() => json({ error: 'Your account is being deleted.' }, 403));
    renderCard();
    choose('Style', 'Anime');
    fireEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toBe('Your account is being deleted.');
    expect(select('Style').textContent).toBe('Anime');
    await waitFor(() => expect(save().disabled).toBe(false));
  });

  it('says when the connection fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    renderCard();
    choose('Style', 'Anime');
    fireEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Check your connection/);
  });

  it('shows Auto for a saved model that is no longer available, ready to save', () => {
    renderCard({ ...APP_GENERATE_DEFAULTS, modelId: 'retired-model' }, true);
    expect(select('Model').textContent).toBe('Auto (recommended)');
    expect(save().disabled).toBe(false);
  });
});
