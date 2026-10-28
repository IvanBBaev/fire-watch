/**
 * The fragment merge step (V3-P1): what the type checker cannot see about the files in this
 * directory. Conventions are in `index.ts`.
 *
 * The copy itself is gated elsewhere, over the merged catalog: CI-10/11, the catalog-render
 * walk and `PENDING_FOUNDER_REVIEW` all read `en.ts` / `bg.ts`, which already contain every
 * fragment. These tests make sure "already contain" stays true.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import bg from '../bg.js';
import en from '../en.js';
import type { Messages } from '../messages.js';
import { BG_FRAGMENTS } from './bg-fragments.js';
import { EN_FRAGMENTS } from './en-fragments.js';

const FILES = readdirSync(fileURLToPath(new URL('.', import.meta.url)));

const LOCALES = [
  { locale: 'en', merged: EN_FRAGMENTS, catalog: en },
  { locale: 'bg', merged: BG_FRAGMENTS, catalog: bg },
] as const;

/** `before-after` → `beforeAfter`. */
function namespaceOf(name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** Fragment names (`before-after`) found on disk for one locale. */
function fragmentNames(locale: string): string[] {
  const suffix = `.${locale}.ts`;
  return FILES.filter((file) => file.endsWith(suffix))
    .map((file) => file.slice(0, -suffix.length))
    .sort();
}

async function loadFragment(name: string, locale: string): Promise<object> {
  const module = (await import(`./${name}.${locale}.ts`)) as { default: object };
  return module.default;
}

describe('i18n fragments (V3-P1)', () => {
  it('holds the moved beforeAfter namespace', () => {
    expect(fragmentNames('en')).toContain('before-after');
  });

  it('gives every fragment a type module and both locales', () => {
    expect(fragmentNames('bg')).toEqual(fragmentNames('en'));
    for (const name of fragmentNames('en')) expect(FILES, name).toContain(`${name}.ts`);
  });

  it.each(LOCALES)(
    'spreads every $locale fragment, unchanged, into the catalog',
    async ({ locale, merged, catalog }) => {
      const byKey = catalog as unknown as Readonly<Record<string, unknown>>;
      const names = fragmentNames(locale);
      for (const name of names) {
        const fragment = await loadFragment(name, locale);
        // One namespace per fragment, named after the file: two files can never claim one key.
        expect(Object.keys(fragment), name).toEqual([namespaceOf(name)]);
        const value = (fragment as Readonly<Record<string, unknown>>)[namespaceOf(name)];
        expect(byKey[namespaceOf(name)], name).toBe(value);
      }
      expect(Object.keys(merged).sort()).toEqual(names.map(namespaceOf).sort());
    },
  );

  it('keeps the moved namespace readable through Messages', () => {
    const read = (messages: Messages) => messages.beforeAfter.open;
    expect(read(en)).toBe('Compare satellite images: before / after');
    expect(read(bg)).toBe('Сравни сателитни изображения: преди / след');
  });
});
