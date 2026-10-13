/**
 * The status banner and freshness chip follow the shell theme and stay readable in it.
 *
 * status.css writes no colour of its own: every text/background pair reads a token from
 * styles.css. This test resolves those tokens for the light theme (`:root`) and the dark
 * theme (both the `prefers-color-scheme` block and `[data-theme='dark']`, which must
 * agree), and holds each pair to WCAG 2.x AA for body text (4.5:1) in both. A token the
 * dark blocks do not override would leave a light colour in dark mode, so that fails too.
 */

// Reads the stylesheets from disk; node types scoped to this file.
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Rgba } from '../../core/color/color.js';
import { contrastRatio } from '../../core/color/color.js';
import type { CssColorDeclaration } from '../../core/color/css-colors.js';
import { extractCssColors } from '../../core/color/css-colors.js';

const read = (relative: string): CssColorDeclaration[] =>
  extractCssColors(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

const shell = read('../../styles.css');
const status = read('./status.css');

const LIGHT = [':root'];
const DARK_MEDIA = ['@media (prefers-color-scheme: dark)', ":root:not([data-theme='light'])"];
const DARK_ATTRIBUTE = [":root[data-theme='dark']"];

/** Custom-property colours declared in exactly this rule context. */
const tokensIn = (context: readonly string[]): Map<string, Rgba> => {
  const tokens = new Map<string, Rgba>();
  for (const declaration of shell) {
    const [only, ...rest] = declaration.colors;
    if (
      declaration.property.startsWith('--') &&
      only !== undefined &&
      rest.length === 0 &&
      declaration.context.join(' > ') === context.join(' > ')
    ) {
      tokens.set(declaration.property, only.color);
    }
  }
  return tokens;
};

const light = tokensIn(LIGHT);
const darkOverrides = tokensIn(DARK_MEDIA);
const dark = new Map([...light, ...darkOverrides]);

/** Rules in status.css that set both a text colour and a background. */
const rules = new Map<string, CssColorDeclaration[]>();
for (const declaration of status) {
  const rule = declaration.context.join(' > ');
  rules.set(rule, [...(rules.get(rule) ?? []), declaration]);
}
const pairs = [...rules]
  .map(([rule, declarations]) => {
    const token = (property: string): string | undefined =>
      declarations.find((declaration) => declaration.property === property)?.varReferences[0];
    return { rule, text: token('color'), background: token('background') };
  })
  .filter(
    (pair): pair is { rule: string; text: string; background: string } =>
      pair.text !== undefined && pair.background !== undefined,
  );

const THEMES = [
  ['light', light],
  ['dark', dark],
] as const;

describe('status.css — tokenised, AA in both themes', () => {
  it('writes no colour literal, only shell tokens', () => {
    const literals = status.flatMap((declaration) =>
      declaration.colors.map((color) => `${String(declaration.line)} ${color.text}`),
    );
    expect(literals).toStrictEqual([]);
    const unknown = status
      .flatMap((declaration) => declaration.varReferences)
      .filter((reference) => reference.startsWith('--color-') && !light.has(reference));
    expect(unknown).toStrictEqual([]);
  });

  it('the two dark blocks agree', () => {
    expect([...tokensIn(DARK_ATTRIBUTE)]).toStrictEqual([...darkOverrides]);
  });

  it('every colour token status.css reads has a dark override', () => {
    const used = status
      .flatMap((declaration) => declaration.varReferences)
      .filter((reference) => reference.startsWith('--color-'));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((reference) => !darkOverrides.has(reference))).toStrictEqual([]);
  });

  it('pairs the banner and every chip state', () => {
    expect(pairs.map((pair) => pair.rule).sort()).toStrictEqual(
      ['.fw-banner', '.fw-chip--aging', '.fw-chip--fresh', '.fw-chip--stale'].sort(),
    );
  });

  for (const [theme, tokens] of THEMES) {
    it(`meets 4.5:1 for every text/background pair in ${theme}`, () => {
      const failing = pairs.flatMap(({ rule, text, background }) => {
        const foreground = tokens.get(text);
        const behind = tokens.get(background);
        if (foreground === undefined || behind === undefined) return [`${rule} unresolved`];
        const ratio = contrastRatio(foreground, behind);
        return ratio < 4.5 ? [`${rule} ${ratio.toFixed(2)}`] : [];
      });
      expect(pairs.length).toBeGreaterThan(0);
      expect(failing).toStrictEqual([]);
    });
  }
});
