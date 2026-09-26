import { describe, expect, it } from 'vitest';

import { formatHex } from './color.js';
import { CssColorError, extractCssColors } from './css-colors.js';

const summary = (source: string): string[] =>
  extractCssColors(source).map(
    (d) =>
      `${String(d.line)} ${d.context.join(' > ')} ${d.property}: ${d.colors
        .map((c) => formatHex(c.color))
        .join(',')} [${d.varReferences.join(',')}]`,
  );

describe('extractCssColors', () => {
  it('reports every colour with its line, rule context and property', () => {
    const source = [
      ':root {',
      '  --color-bg: #ffffff;',
      '  --color-overlay: rgba(31, 36, 40, 0.55);',
      '}',
      '@media (prefers-color-scheme: dark) {',
      "  :root:not([data-theme='light']) {",
      '    --color-bg: #16191c;',
      '  }',
      '}',
      '.x { border: 1px solid tomato; color: var(--color-text) }',
    ].join('\n');
    expect(summary(source)).toStrictEqual([
      '2 :root --color-bg: #ffffff []',
      '3 :root --color-overlay: #1f24288c []',
      "7 @media (prefers-color-scheme: dark) > :root:not([data-theme='light']) --color-bg: #16191c []",
      '10 .x border: #ff6347 []',
      '10 .x color:  [--color-text]',
    ]);
  });

  it('ignores comments, strings and url() fragments, keeping line numbers', () => {
    const source = [
      '/* color: #ff0000; */',
      '.a {',
      "  content: '#ff0000 red';",
      '  background: url(#fragment) no-repeat;',
      '  outline-color: currentcolor;',
      '  --color-red-ish: #0000ff;',
      '}',
    ].join('\n');
    expect(summary(source)).toStrictEqual(['6 .a --color-red-ish: #0000ff []']);
  });

  it('does not read identifiers that merely contain a colour name', () => {
    expect(summary('.a { transition: color-red 1s; grid-area: redbox; }')).toStrictEqual([]);
  });

  it.each([
    ['a malformed hex', '.a { color: #12345; }', /line 1/u],
    ['a colour function it cannot convert', '.a {\n color: oklch(0.6 0.2 30); }', /line 2/u],
    ['color-mix', '.a { color: color-mix(in srgb, red, blue); }', /color-mix/u],
    ['a non-declaration', '.a { color }', /not a declaration/u],
    ['an unclosed block', '.a { color: red;', /unclosed/u],
    ['a stray brace', '.a { color: red; } }', /unbalanced/u],
    ['unbalanced parentheses', '.a { color: rgb(1, 2, 3; }', /unbalanced parentheses/u],
  ])('throws on %s', (_name, source, message) => {
    expect(() => extractCssColors(source)).toThrow(CssColorError);
    expect(() => extractCssColors(source)).toThrow(message);
  });
});
