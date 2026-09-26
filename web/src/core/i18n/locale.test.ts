import { describe, expect, it } from 'vitest';

import { detectLocale, loadMessages, persistLocale, resolveLocale } from './locale.js';

describe('resolveLocale precedence', () => {
  it('lets a persisted locale win over the browser language', () => {
    expect(resolveLocale('en', 'bg-BG')).toBe('en');
    expect(resolveLocale('bg', 'en-US')).toBe('bg');
  });

  it('ignores garbage in storage and falls through to the browser language', () => {
    expect(resolveLocale('fr', 'bg-BG')).toBe('bg');
    expect(resolveLocale('', 'en-US')).toBe('en');
  });

  it('maps any language starting with bg to bg, case-insensitively', () => {
    expect(resolveLocale(null, 'bg')).toBe('bg');
    expect(resolveLocale(null, 'bg-BG')).toBe('bg');
    expect(resolveLocale(null, 'BG')).toBe('bg');
  });

  it('maps any other known language to en', () => {
    expect(resolveLocale(null, 'en-US')).toBe('en');
    expect(resolveLocale(null, 'de-DE')).toBe('en');
    expect(resolveLocale(null, 'tr')).toBe('en');
  });

  it('defaults to bg when the language is unknown or absent (bg-first product)', () => {
    expect(resolveLocale(null, null)).toBe('bg');
    expect(resolveLocale(null, '')).toBe('bg');
    expect(resolveLocale('fr', null)).toBe('bg');
  });
});

describe('node safety (no DOM, possibly no localStorage)', () => {
  it('detectLocale runs without browser globals and returns a valid locale', () => {
    let detected: string | undefined;
    expect(() => {
      detected = detectLocale();
    }).not.toThrow();
    expect(['bg', 'en']).toContain(detected);
  });

  it('persistLocale is a safe no-op where storage is unavailable', () => {
    expect(() => {
      persistLocale('en');
    }).not.toThrow();
  });
});

describe('loadMessages', () => {
  it('loads a complete catalog per locale through the code-split map', async () => {
    const bg = await loadMessages('bg');
    const en = await loadMessages('en');

    // The product name stays untranslated in both catalogs.
    expect(bg.appTitle).toBe('Fire Watch');
    expect(en.appTitle).toBe('Fire Watch');

    // The two catalogs are distinct objects with distinct copy.
    expect(bg.nav.map).toBe('Карта');
    expect(en.nav.map).toBe('Map');
  });
});
