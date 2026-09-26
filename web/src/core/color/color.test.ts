import { describe, expect, it } from 'vitest';

import type { Lab } from './color.js';
import {
  ColorParseError,
  deltaE2000,
  formatHex,
  isNamedColor,
  parseColor,
  toLab,
  toOklch,
} from './color.js';

describe('parseColor', () => {
  it.each([
    ['#d7301f', '#d7301f'],
    ['#FFF', '#ffffff'],
    ['#0f08', '#00ff0088'],
    ['#11223344', '#11223344'],
    ['rgb(215, 48, 31)', '#d7301f'],
    ['rgba(241, 105, 19, 0.18)', '#f169132e'],
    ['rgb(215 48 31 / 50%)', '#d7301f80'],
    ['rgb(100%, 0%, 0%)', '#ff0000'],
    ['hsl(0, 100%, 50%)', '#ff0000'],
    ['hsl(120deg 100% 25%)', '#008000'],
    ['hsla(240, 100%, 50%, 0.5)', '#0000ff80'],
    ['Tomato', '#ff6347'],
    ['transparent', '#00000000'],
  ])('reads %s', (input, expected) => {
    expect(formatHex(parseColor(input))).toBe(expected);
  });

  // A lint that skips what it cannot read reports green over exactly the values it
  // never looked at, so every unreadable form is an error, never a default.
  it.each([
    '#12345',
    '#ggg',
    '#',
    'rgb(1, 2)',
    'rgb(1, 2, 300)',
    'rgba(1, 2, 3, 2)',
    'hsl(0, 50, 50)',
    'oklch(0.6 0.2 30)',
    'color-mix(in srgb, red, blue)',
    'light-dark(#fff, #000)',
    'fire-red',
    '',
  ])('refuses %j loudly', (input) => {
    expect(() => parseColor(input)).toThrow(ColorParseError);
  });

  it('knows the CSS keywords, and only those', () => {
    expect(isNamedColor('rebeccapurple')).toBe(true);
    expect(isNamedColor('ORANGERED')).toBe(true);
    expect(isNamedColor('transparent')).toBe(true);
    expect(isNamedColor('solid')).toBe(false);
    expect(isNamedColor('currentcolor')).toBe(false);
  });
});

describe('OKLCH (Ottosson 2020; CSS Color 4 reference values)', () => {
  it.each([
    ['#ff0000', 0.62796, 0.25768, 29.2339],
    ['#00ff00', 0.86644, 0.29483, 142.4953],
    ['#0000ff', 0.45201, 0.31321, 264.052],
  ])('%s', (input, l, c, h) => {
    const oklch = toOklch(parseColor(input));
    expect(oklch.l).toBeCloseTo(l, 4);
    expect(oklch.c).toBeCloseTo(c, 4);
    expect(oklch.h).toBeCloseTo(h, 3);
  });

  it('gives an achromatic colour zero chroma', () => {
    expect(toOklch(parseColor('#ffffff')).c).toBeCloseTo(0, 6);
    expect(toOklch(parseColor('#808080')).c).toBeCloseTo(0, 6);
  });
});

describe('CIELAB D65', () => {
  it('matches the standard sRGB primaries', () => {
    const red = toLab(parseColor('#ff0000'));
    expect(red.l).toBeCloseTo(53.2408, 3);
    expect(red.a).toBeCloseTo(80.0925, 3);
    expect(red.b).toBeCloseTo(67.2032, 3);
    const white = toLab(parseColor('#ffffff'));
    expect(white.l).toBeCloseTo(100, 3);
    expect(white.a).toBeCloseTo(0, 3);
    expect(white.b).toBeCloseTo(0, 3);
  });
});

describe('CIEDE2000 (Sharma, Wu & Dalal 2005 test data)', () => {
  const lab = (l: number, a: number, b: number): Lab => ({ l, a, b });
  it.each([
    [1, lab(50, 2.6772, -79.7751), lab(50, 0, -82.7485), 2.0425],
    [2, lab(50, 3.1571, -77.2803), lab(50, 0, -82.7485), 2.8615],
    [4, lab(50, -1.3802, -84.2814), lab(50, 0, -82.7485), 1.0],
    [7, lab(50, 0, 0), lab(50, -1, 2), 2.3669],
    [9, lab(50, 2.49, -0.001), lab(50, -2.49, 0.0009), 7.1792],
    [11, lab(50, 2.49, -0.001), lab(50, -2.49, 0.0011), 7.2195],
    [13, lab(50, -0.001, 2.49), lab(50, 0.0009, -2.49), 4.8045],
    [17, lab(50, 2.5, 0), lab(73, 25, -18), 27.1492],
    [18, lab(50, 2.5, 0), lab(61, -5, 29), 22.8977],
    [19, lab(50, 2.5, 0), lab(56, -27, -3), 31.903],
    [20, lab(50, 2.5, 0), lab(58, 24, 15), 19.4535],
    [21, lab(50, 2.5, 0), lab(50, 3.1736, 0.5854), 1.0],
  ])('pair %i', (_pair, first, second, expected) => {
    expect(deltaE2000(first, second)).toBeCloseTo(expected, 4);
    expect(deltaE2000(second, first)).toBeCloseTo(expected, 4);
  });

  it('is zero for identical colours', () => {
    expect(deltaE2000(lab(42, 10, -3), lab(42, 10, -3))).toBe(0);
  });
});
