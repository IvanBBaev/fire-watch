/**
 * The storage side of cross-device sync (V2-C5): what this browser's remembered choices
 * read as, which fields an opening link pins, and the stored base. The live wiring (the
 * effects, the requests) is covered by `e2e/preferences-sync.e2e.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load() {
  return import('./preferences-sync.js');
}

describe('readLocalPreferences', () => {
  it('is empty when nothing was ever chosen', async () => {
    const { readLocalPreferences } = await load();
    expect(readLocalPreferences(() => null)).toEqual({});
  });

  it('reads every remembered choice and ignores what this build would not', async () => {
    const { readLocalPreferences } = await load();
    const stored: Record<string, string> = {
      'fw:layers': 'wind,fwi,nonsense',
      'fw:static-sources': 'on',
      'fw:protected-sites': 'off',
      'fw:theme': 'dark',
      'fw:locale': 'en',
      'fw.age-window': '6h',
      'fw:new-signals-sound': 'off',
    };
    expect(readLocalPreferences((key) => stored[key] ?? null)).toEqual({
      overlays: ['fwi', 'wind'],
      static_sources: true,
      protected_sites: false,
      theme: 'dark',
      locale: 'en',
      age_window: '6h',
      new_signal_sound: false,
    });
    const garbled = (key: string) =>
      key === 'fw:theme' ? 'sepia' : key === 'fw:locale' ? 'de' : 'maybe';
    expect(readLocalPreferences(garbled)).toEqual({ overlays: [] });
  });
});

describe('PREFERENCE_STORAGE_KEYS', () => {
  it('names the keys the owning modules remember each choice under', async () => {
    const { PREFERENCE_STORAGE_KEYS } = await load();
    const [layers, statics, sites, theme, locale, age, sound] = await Promise.all([
      import('./layers.js'),
      import('./static-sources.js'),
      import('./protected-sites.js'),
      import('./logic/theme.js'),
      import('../core/i18n/locale.js'),
      import('../core/time/age-filter.js'),
      import('./new-signals.js'),
    ]);
    expect(PREFERENCE_STORAGE_KEYS).toEqual({
      overlays: layers.LAYERS_STORAGE_KEY,
      static_sources: statics.STATIC_SOURCES_STORAGE_KEY,
      protected_sites: sites.PROTECTED_SITES_STORAGE_KEY,
      theme: theme.THEME_STORAGE_KEY,
      locale: locale.LOCALE_STORAGE_KEY,
      age_window: age.AGE_WINDOW_STORAGE_KEY,
      new_signal_sound: sound.SOUND_STORAGE_KEY,
    });
  });
});

describe('linkStatedFields', () => {
  it('pins the layers for an ov= link and the window for a t= link', async () => {
    const { linkStatedFields } = await load();
    expect([...linkStatedFields('')]).toEqual([]);
    expect([...linkStatedFields('#ov=wind')]).toEqual([
      'overlays',
      'static_sources',
      'protected_sites',
    ]);
    expect([...linkStatedFields('#ov=')]).toHaveLength(3);
    expect([...linkStatedFields('#t=6h')]).toEqual(['age_window']);
    expect([...linkStatedFields('#t=nonsense')]).toEqual([]);
  });
});

describe('parseSyncBase', () => {
  it('round-trips a stored base and refuses anything else', async () => {
    const { parseSyncBase } = await load();
    const base = { revision: 3, preferences: { theme: 'dark' } };
    expect(parseSyncBase(JSON.stringify(base))).toEqual(base);
    expect(parseSyncBase(null)).toBeNull();
    expect(parseSyncBase('{')).toBeNull();
    expect(parseSyncBase(JSON.stringify({ revision: -1, preferences: {} }))).toBeNull();
    expect(parseSyncBase(JSON.stringify({ revision: 1, preferences: { theme: 'x' } }))).toBeNull();
  });
});
