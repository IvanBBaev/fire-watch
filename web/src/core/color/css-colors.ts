/**
 * Every colour a stylesheet writes, with where it wrote it — the CSS half of the CI-14 walk.
 *
 * Deliberately a small tokenizer and not a CSS parser: the gate needs each declaration's
 * rule context, property, line and colour tokens, nothing else. What it must never do is
 * skip something it did not understand, so every failure mode is a throw:
 * - a colour token {@link parseColor} cannot read (`#12345`, `oklch(…)`, `color-mix(…)`);
 * - text inside a rule that is not a `property: value` declaration;
 * - unbalanced braces or parentheses.
 * Each error names the line, because the reader of a red CI run needs the place, not the
 * value.
 */

import type { Rgba } from './color.js';
import { isNamedColor, parseColor } from './color.js';

export interface CssColorToken {
  /** The token as written, e.g. `#faf0d1`, `rgba(0, 0, 0, 0.65)`, `tomato`. */
  readonly text: string;
  readonly color: Rgba;
}

export interface CssColorDeclaration {
  /** 1-based line of the declaration's property name. */
  readonly line: number;
  /** Enclosing preludes, outermost first: `['@media (…)', ':root:not(…)']`. */
  readonly context: readonly string[];
  readonly property: string;
  readonly colors: readonly CssColorToken[];
  /** Custom properties the value reads through `var()`, e.g. `--color-bg`. */
  readonly varReferences: readonly string[];
}

export class CssColorError extends Error {
  constructor(line: number, reason: string) {
    super(`line ${String(line)}: ${reason}`);
    this.name = 'CssColorError';
  }
}

/** Functions whose whole call is one colour value. */
const COLOR_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'device-cmyk',
]);

/** Blanks every character but newlines, so offsets and line numbers survive. */
const blank = (text: string): string => text.replace(/[^\n]/gu, ' ');

function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, blank);
}

function blankStrings(source: string): string {
  return source.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu, blank);
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Index of the `)` closing the `(` at `open`, or throws. */
function closingParen(text: string, open: number, line: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new CssColorError(line, 'unbalanced parentheses');
}

function colorTokens(rawValue: string, line: number): CssColorToken[] {
  const read = (text: string): CssColorToken => {
    try {
      return { text, color: parseColor(text) };
    } catch (error) {
      throw new CssColorError(line, error instanceof Error ? error.message : String(error));
    }
  };
  const tokens: CssColorToken[] = [];
  let value = rawValue;

  // url(…) can hold anything, including `#fragment`s; it is never a colour.
  value = value.replace(/url\([^)]*\)/giu, (match) => ' '.repeat(match.length));

  // Colour functions first, lifted out whole so their arguments are not re-read as tokens.
  const fn = /([a-z][a-z-]*)\(/giu;
  let match: RegExpExecArray | null;
  while ((match = fn.exec(value)) !== null) {
    const name = (match[1] ?? '').toLowerCase();
    if (!COLOR_FUNCTIONS.has(name)) continue;
    const open = match.index + match[0].length - 1;
    const close = closingParen(value, open, line);
    tokens.push(read(value.slice(match.index, close + 1)));
    value =
      value.slice(0, match.index) + ' '.repeat(close + 1 - match.index) + value.slice(close + 1);
    fn.lastIndex = close + 1;
  }

  // Any `#…` in a value is a hex colour or an error — CSS has no other use for it there.
  for (const hex of value.matchAll(/#[\w-]*/gu)) tokens.push(read(hex[0]));
  value = value.replace(/#[\w-]*/gu, ' ');

  // Keywords: whole identifiers only, so `--color-red-ish` or `var(--x)` never match.
  for (const word of value.matchAll(/(?<![\w-])[a-z][\w-]*/giu)) {
    if (isNamedColor(word[0])) tokens.push(read(word[0]));
  }
  return tokens;
}

/**
 * Every declaration in `source` that writes at least one colour or reads at least one
 * custom property. Throws {@link CssColorError} rather than skip anything unreadable.
 */
export function extractCssColors(source: string): CssColorDeclaration[] {
  // Selectors keep their strings (`[data-theme='dark']`); values do not need them.
  const uncommented = blankComments(source);
  const text = blankStrings(uncommented);
  const declarations: CssColorDeclaration[] = [];
  const context: string[] = [];
  let start = 0;

  const flush = (end: number): void => {
    const chunk = text.slice(start, end);
    const offset = start + (chunk.length - chunk.trimStart().length);
    const body = chunk.trim();
    if (body === '') return;
    const line = lineAt(source, offset);
    if (context.length === 0) {
      // Top-level statements are at-rules (`@import …;`, `@charset …;`); nothing else is
      // legal CSS outside a block.
      if (body.startsWith('@')) return;
      throw new CssColorError(line, `unexpected text outside any rule: ${JSON.stringify(body)}`);
    }
    const colon = body.indexOf(':');
    if (colon <= 0) throw new CssColorError(line, `not a declaration: ${JSON.stringify(body)}`);
    const property = body.slice(0, colon).trim();
    const value = body.slice(colon + 1);
    const colors = colorTokens(value, line);
    const varReferences = [...value.matchAll(/var\(\s*(--[\w-]+)/gu)].map((ref) => ref[1] ?? '');
    if (colors.length > 0 || varReferences.length > 0) {
      declarations.push({ line, context: [...context], property, colors, varReferences });
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') {
      context.push(uncommented.slice(start, i).trim().replace(/\s+/gu, ' '));
      start = i + 1;
    } else if (char === ';') {
      flush(i);
      start = i + 1;
    } else if (char === '}') {
      flush(i);
      if (context.pop() === undefined) throw new CssColorError(lineAt(source, i), 'unbalanced "}"');
      start = i + 1;
    }
  }
  if (context.length > 0) throw new CssColorError(lineAt(source, text.length), 'unclosed "{"');
  if (text.slice(start).trim() !== '') {
    throw new CssColorError(lineAt(source, start), 'trailing text after the last rule');
  }
  return declarations;
}
