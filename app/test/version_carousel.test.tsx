// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionCarousel } from '../src/components/version_carousel';
import type { ImageVersionBody } from '../src/lib/images';

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

const LONG = 'A lighthouse at dusk with gulls over a calm sea. '.repeat(30);
const VERSIONS = [
  version(1, { prompt: LONG }),
  ...Array.from({ length: 11 }, (_, index) =>
    version(index + 2, { parentVersion: index + 1, editInstruction: `Edit number ${index + 2}` }),
  ),
];

/** The carousel with real selection state, as the detail view uses it. */
function Harness({ start, onSelect }: { start: number; onSelect?: (version: number) => void }) {
  const [selected, setSelected] = useState(start);
  return (
    <VersionCarousel
      versions={VERSIONS}
      selected={selected}
      onSelect={(next) => {
        onSelect?.(next);
        setSelected(next);
      }}
    />
  );
}

const pressed = () =>
  within(screen.getByRole('list', { name: 'Versions' }))
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.getAttribute('aria-label'));

describe('VersionCarousel', () => {
  afterEach(cleanup);

  it('lists every version as one row of thumbnails, with the selected one marked', () => {
    render(<Harness start={12} />);
    const list = screen.getByRole('list', { name: 'Versions' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(12);
    // One scrolling row, whatever the number of versions or the length of their prompts.
    expect(list.className).toMatch(/overflow-x-auto/);
    expect(list.className).not.toMatch(/flex-col/);
    expect(pressed()).toEqual(['Version 12']);
    // Long prompts live in the tooltip, trimmed, not in the row.
    const first = screen.getByRole('button', { name: 'Version 1' });
    expect(first.textContent).toBe('v1');
    expect(first.getAttribute('title')!.length).toBeLessThanOrEqual(150);
  });

  it('selects a version when its thumbnail is clicked', () => {
    const onSelect = vi.fn();
    render(<Harness start={12} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Version 3' }));
    expect(onSelect).toHaveBeenCalledWith(3);
    expect(pressed()).toEqual(['Version 3']);
  });

  it('steps through the versions with previous and next, disabled at the ends', () => {
    render(<Harness start={2} />);
    const previous = screen.getByRole<HTMLButtonElement>('button', { name: 'Previous version' });
    const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Next version' });
    expect(previous.disabled).toBe(false);

    fireEvent.click(previous);
    expect(pressed()).toEqual(['Version 1']);
    expect(previous.disabled).toBe(true);

    fireEvent.click(next);
    fireEvent.click(next);
    expect(pressed()).toEqual(['Version 3']);

    fireEvent.click(screen.getByRole('button', { name: 'Version 12' }));
    expect(next.disabled).toBe(true);
  });

  it('scrolls the selected thumbnail into view within the row', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<Harness start={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next version' }));
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(
      screen.getByRole('button', { name: 'Version 2' }),
    );
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });
});
