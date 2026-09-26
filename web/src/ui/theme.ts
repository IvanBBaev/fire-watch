/**
 * Theme state as signals (ADR-005 D2) plus its DOM glue: the stored preference, the
 * live system preference, and the resolved ThemeName the map controller consumes.
 *
 * The stylesheet needs no JS for `auto` — it defaults to `prefers-color-scheme` and an
 * explicit `data-theme` attribute overrides it (see styles.css). JS mirrors the same
 * resolution only because MapLibre styles are swapped imperatively.
 */

import { computed, signal } from '@preact/signals';

import type { ThemeName } from '../core/types.js';
import type { ThemePreference } from './logic/theme.js';
import {
  THEME_STORAGE_KEY,
  documentThemeAttribute,
  parseThemePreference,
  resolveTheme,
} from './logic/theme.js';
import { readStorage, writeStorage } from './storage.js';

const preference = signal<ThemePreference>('auto');
const systemPrefersDark = signal(false);

/** Read-only view for the settings page radios. */
export const themePreference = computed(() => preference.value);

/** The concrete theme in effect — feed this to createMapController / setTheme. */
export const appliedTheme = computed<ThemeName>(() =>
  resolveTheme(preference.value, systemPrefersDark.value),
);

function applyDocumentAttribute(): void {
  const attribute = documentThemeAttribute(preference.value);
  const root = document.documentElement;
  if (attribute === null) {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', attribute);
  }
}

/**
 * Called once from boot, before first render, so the first paint already has the
 * stored theme and `auto` tracks the OS live via the matchMedia listener.
 */
export function initTheme(): void {
  preference.value = parseThemePreference(readStorage(THEME_STORAGE_KEY));
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  systemPrefersDark.value = media.matches;
  media.addEventListener('change', (event) => {
    systemPrefersDark.value = event.matches;
  });
  applyDocumentAttribute();
}

export function setThemePreference(next: ThemePreference): void {
  preference.value = next;
  writeStorage(THEME_STORAGE_KEY, next);
  applyDocumentAttribute();
}
