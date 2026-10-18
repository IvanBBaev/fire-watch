/**
 * The theme signals and their DOM glue: the stored preference is read at boot, `auto`
 * follows the OS live, and `data-theme` is set only for an explicit choice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THEME_STORAGE_KEY } from './logic/theme.js';

interface Env {
  data: Map<string, string>;
  attributes: Map<string, string>;
  media: { matches: boolean; fire: (matches: boolean) => void };
}

function stubBrowser(stored: string | null, prefersDark: boolean): Env {
  const data = new Map<string, string>();
  if (stored !== null) data.set(THEME_STORAGE_KEY, stored);
  const attributes = new Map<string, string>();
  let listener: ((event: { matches: boolean }) => void) | null = null;
  const media = {
    matches: prefersDark,
    fire: (matches: boolean) => listener?.({ matches }),
  };
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    },
    matchMedia: () => ({
      matches: media.matches,
      addEventListener: (_name: string, fn: (event: { matches: boolean }) => void) => {
        listener = fn;
      },
    }),
  });
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
    },
  });
  return { data, attributes, media };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme', () => {
  it('resolves auto from the system preference and leaves data-theme unset', async () => {
    const env = stubBrowser(null, true);
    const { initTheme, themePreference, appliedTheme } = await import('./theme.js');
    initTheme();
    expect(themePreference.value).toBe('auto');
    expect(appliedTheme.value).toBe('dark');
    expect(env.attributes.has('data-theme')).toBe(false);
  });

  it('restores a stored explicit preference and applies it to <html>', async () => {
    const env = stubBrowser('light', true);
    const { initTheme, themePreference, appliedTheme } = await import('./theme.js');
    initTheme();
    expect(themePreference.value).toBe('light');
    expect(appliedTheme.value).toBe('light');
    expect(env.attributes.get('data-theme')).toBe('light');
  });

  it('falls back to auto for a corrupted stored value', async () => {
    stubBrowser('purple', false);
    const { initTheme, themePreference, appliedTheme } = await import('./theme.js');
    initTheme();
    expect(themePreference.value).toBe('auto');
    expect(appliedTheme.value).toBe('light');
  });

  it('tracks the OS live while on auto, and ignores it once explicit', async () => {
    const env = stubBrowser(null, false);
    const { initTheme, setThemePreference, appliedTheme } = await import('./theme.js');
    initTheme();
    env.media.fire(true);
    expect(appliedTheme.value).toBe('dark');
    setThemePreference('light');
    env.media.fire(true);
    expect(appliedTheme.value).toBe('light');
  });

  it('setThemePreference stores the choice and toggles data-theme', async () => {
    const env = stubBrowser(null, false);
    const { initTheme, setThemePreference } = await import('./theme.js');
    initTheme();
    setThemePreference('dark');
    expect(env.data.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(env.attributes.get('data-theme')).toBe('dark');
    setThemePreference('auto');
    expect(env.data.get(THEME_STORAGE_KEY)).toBe('auto');
    expect(env.attributes.has('data-theme')).toBe(false);
  });
});
