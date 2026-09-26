/**
 * Pure theme decisions (07-product-ux P8). The DOM side — localStorage, matchMedia,
 * `data-theme` on <html> — lives in `ui/theme.ts`; this module is the testable part.
 *
 * Resolution contract (mirrors styles.css): the stylesheet defaults to
 * `prefers-color-scheme`, and an explicit `data-theme='light'|'dark'` attribute wins.
 * `auto` therefore maps to *no* attribute, and the resolved ThemeName exists only so the
 * map controller (which cannot read CSS) receives a concrete theme.
 */

import type { ThemeName } from '../../core/types.js';

export type ThemePreference = 'light' | 'dark' | 'auto';

export const THEME_STORAGE_KEY = 'fw:theme';

const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'auto'];

/** Anything unknown (missing, corrupted, from an older build) falls back to `auto`. */
export function parseThemePreference(stored: string | null): ThemePreference {
  return (PREFERENCES as readonly string[]).includes(stored ?? '')
    ? (stored as ThemePreference)
    : 'auto';
}

/** The concrete theme in effect — what MapControllerDeps.theme / setTheme receive. */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ThemeName {
  if (preference === 'auto') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}

/**
 * What `data-theme` on <html> should be: `null` means "remove the attribute", letting
 * the stylesheet's `prefers-color-scheme` default take over (and track live changes
 * without JS involvement).
 */
export function documentThemeAttribute(preference: ThemePreference): ThemeName | null {
  return preference === 'auto' ? null : preference;
}
