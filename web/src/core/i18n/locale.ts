/**
 * Locale detection, persistence and catalog loading.
 *
 * Bulgarian is the default locale — this is a bg-first product, so an unknown or absent
 * browser language resolves to `bg`, and only an explicit non-Bulgarian language resolves
 * to `en`. Detection precedence: the persisted choice wins, then the browser language,
 * then the default. Every browser global is feature-checked so this module also runs in
 * the node test environment (where `localStorage` may not exist at all).
 */

import type { Locale } from '../types.js';
import type { Messages } from './messages.js';

/**
 * Code-split catalog loader (review 08 §5.2.7) — the non-default locale never rides in
 * the entry chunk. It lives here rather than in `messages.ts` so the catalogs can import
 * the `Messages` type without creating an import cycle (CI `no-circular`).
 */
const load: Readonly<Record<Locale, () => Promise<{ default: Messages }>>> = {
  bg: () => import('./bg.js'),
  en: () => import('./en.js'),
};

export const LOCALE_STORAGE_KEY = 'fw:locale';

function isLocale(value: unknown): value is Locale {
  return value === 'bg' || value === 'en';
}

/**
 * The pure precedence rule behind `detectLocale`, exported so tests can exercise it
 * without faking browser globals:
 *
 * 1. a persisted `'bg'`/`'en'` wins (anything else in storage is ignored);
 * 2. a browser language starting with `bg` (case-insensitive) resolves to `bg`;
 * 3. any other *known* browser language resolves to `en`;
 * 4. unknown or absent language falls back to the default, `bg`.
 */
export function resolveLocale(stored: string | null, browserLanguage: string | null): Locale {
  if (isLocale(stored)) return stored;
  if (browserLanguage !== null && browserLanguage !== '') {
    return browserLanguage.toLowerCase().startsWith('bg') ? 'bg' : 'en';
  }
  return 'bg';
}

function readStoredLocale(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Storage access can throw (privacy modes); treat it as "nothing persisted".
    return null;
  }
}

function readBrowserLanguage(): string | null {
  if (typeof navigator === 'undefined') return null;
  const { language } = navigator;
  return typeof language === 'string' ? language : null;
}

export function detectLocale(): Locale {
  return resolveLocale(readStoredLocale(), readBrowserLanguage());
}

export function persistLocale(locale: Locale): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Quota / privacy-mode failures are non-fatal: the choice just does not stick.
  }
}

/** Loads the catalog code-split via the `messages.ts` load map (review 08 §5.2.7). */
export async function loadMessages(locale: Locale): Promise<Messages> {
  const catalogModule = await load[locale]();
  return catalogModule.default;
}
