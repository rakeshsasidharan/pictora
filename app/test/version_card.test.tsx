// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionCard, versionPrompt } from '../src/components/version_card';
import type { ImageVersionBody } from '../src/lib/images';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function version(n: number, fields: Partial<ImageVersionBody> = {}): ImageVersionBody {
  return {
    version: n,
    width: 1024,
    height: 1024,
    url: `https://signed.example/v${n}.png`,
    downloadUrl: `https://signed.example/v${n}.png?download`,
    thumbUrl: `https://signed.example/v${n}_thumb.webp`,
    ...fields,
  };
}

const LONG = `A lighthouse at dusk, ${'with gulls over a calm sea and warm light on the rocks, '.repeat(20)}`;

function renderCard(card: ImageVersionBody, selected = false) {
  const onSelect = vi.fn();
  render(
    <ol>
      <VersionCard version={card} selected={selected} onSelect={onSelect} />
    </ol>,
  );
  return onSelect;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const spy = vi.fn(writeText);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: spy } });
  return spy;
}

describe('VersionCard', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it('selects its version from the button, which shows the number and the parent', () => {
    const onSelect = renderCard(version(2, { parentVersion: 1, editInstruction: 'Make it night' }));
    const button = screen.getByRole('button', { name: 'Version 2' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toBe('Version 2Edited from version 1');
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('marks the selected version', () => {
    renderCard(version(1, { prompt: 'A lighthouse' }), true);
    expect(screen.getByRole('button', { name: 'Version 1' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('keeps long text in a short box that scrolls, and can be scrolled from the keyboard', () => {
    renderCard(version(1, { prompt: LONG }));
    const text = screen.getByLabelText('Prompt of version 1');
    expect(text.textContent).toBe(LONG);
    // shadcn's ScrollArea: its viewport is the capped, focusable box.
    expect(text.getAttribute('data-slot')).toBe('scroll-area-viewport');
    expect(text.className).toMatch(/max-h-20/);
    expect(text.getAttribute('tabindex')).toBe('0');
  });

  it('copies the prompt, or the edit instruction, and confirms with a toast', async () => {
    const writeText = stubClipboard(async () => undefined);
    renderCard(version(1, { prompt: LONG }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy the prompt of version 1' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Prompt copied'));
    expect(writeText).toHaveBeenCalledWith(LONG);

    cleanup();
    renderCard(version(2, { parentVersion: 1, prompt: 'Original', editInstruction: 'Add snow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy the prompt of version 2' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('Add snow'));
  });

  it('says so when the clipboard refuses', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
    renderCard(version(1, { prompt: 'A lighthouse' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy the prompt of version 1' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't copy the prompt. Select the text and copy it instead.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('has nothing to copy for an uploaded image', () => {
    renderCard(version(1, { source: 'upload' }));
    expect(screen.getByLabelText('Prompt of version 1').textContent).toBe('Uploaded image');
    expect(screen.queryByRole('button', { name: /Copy the prompt/ })).toBeNull();
  });
});

describe('versionPrompt', () => {
  it('is the edit instruction, then the prompt, and nothing for an upload', () => {
    expect(versionPrompt(version(2, { prompt: 'A', editInstruction: 'B' }))).toBe('B');
    expect(versionPrompt(version(1, { prompt: 'A' }))).toBe('A');
    expect(versionPrompt(version(1, { source: 'upload' }))).toBeUndefined();
  });
});
