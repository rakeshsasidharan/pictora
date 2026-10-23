// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../src/components/theme_provider';
import { ThemeSwitcher } from '../src/components/theme_switcher';

/** A stand-in for the OS colour scheme that tests can flip, as `prefers-color-scheme` would. */
function osScheme(initial: 'light' | 'dark') {
  let dark = initial === 'dark';
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('dark') ? dark : false;
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
    })),
  );
  window.matchMedia = globalThis.matchMedia;
  return {
    set(scheme: 'light' | 'dark') {
      dark = scheme === 'dark';
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

const html = () => document.documentElement.classList;

function pick(label: 'Light' | 'Dark' | 'System') {
  // Radix opens the menu on pointer down, or Enter from the keyboard.
  fireEvent.keyDown(screen.getByRole('button', { name: 'Theme' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
}

function renderSwitcher() {
  render(
    <ThemeProvider>
      <ThemeSwitcher />
    </ThemeProvider>,
  );
}

describe('ThemeSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('follows the OS by default, live', () => {
    const os = osScheme('dark');
    renderSwitcher();
    expect(html().contains('dark')).toBe(true);
    os.set('light');
    expect(html().contains('light')).toBe(true);
    expect(html().contains('dark')).toBe(false);
  });

  it('sets light, dark and system, and keeps the choice', () => {
    osScheme('light');
    renderSwitcher();
    pick('Dark');
    expect(html().contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');

    pick('Light');
    expect(html().contains('light')).toBe(true);
    expect(html().contains('dark')).toBe(false);
    expect(localStorage.getItem('theme')).toBe('light');

    pick('System');
    expect(localStorage.getItem('theme')).toBe('system');
    expect(html().contains('light')).toBe(true);
  });

  it('shows the current choice as checked', () => {
    osScheme('light');
    localStorage.setItem('theme', 'dark');
    renderSwitcher();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Theme' }), { key: 'Enter' });
    expect(screen.getByRole('menuitemradio', { name: 'Dark' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'System' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });
});
