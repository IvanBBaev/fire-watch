import { describe, expect, it } from 'vitest';

import { documentThemeAttribute, parseThemePreference, resolveTheme } from './theme.js';

describe('parseThemePreference', () => {
  it('accepts the three known preferences', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('auto')).toBe('auto');
  });

  it('falls back to auto for missing or corrupted values', () => {
    expect(parseThemePreference(null)).toBe('auto');
    expect(parseThemePreference('')).toBe('auto');
    expect(parseThemePreference('midnight')).toBe('auto');
    expect(parseThemePreference('DARK')).toBe('auto');
  });
});

describe('resolveTheme', () => {
  it('explicit preferences ignore the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('auto follows the system preference', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
  });
});

describe('documentThemeAttribute', () => {
  it('maps explicit preferences to the attribute value', () => {
    expect(documentThemeAttribute('light')).toBe('light');
    expect(documentThemeAttribute('dark')).toBe('dark');
  });

  it('maps auto to no attribute so CSS prefers-color-scheme decides', () => {
    expect(documentThemeAttribute('auto')).toBeNull();
  });
});
