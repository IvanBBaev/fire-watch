/**
 * Colour parsing and the colour spaces the CI-14 gate measures in — pure maths, no DOM.
 *
 * The gate (review 06 §5.4) states its thresholds in two spaces: the "fire owns red" hue
 * band in **OKLCH**, and the CVD separation between fire classes as **CIEDE2000** (ΔE00),
 * which is defined over CIELAB. Both are computed here from sRGB with the standard
 * published matrices so the gate depends on no colour library.
 *
 * `parseColor` accepts exactly the syntaxes this repo writes (hex, `rgb()`/`rgba()`,
 * `hsl()`/`hsla()`, CSS named colours) and **throws on anything else**. A colour the gate
 * cannot read is a colour it cannot check, and a silently skipped value is how a lint
 * stops covering the one declaration that mattered — so newer CSS syntaxes (`oklch()`,
 * `color-mix()`, `light-dark()`, …) fail loudly until someone teaches the parser them.
 */

/** 8-bit sRGB channels plus straight alpha in [0, 1]. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface Oklch {
  /** Perceived lightness, 0–1. */
  readonly l: number;
  /** Chroma; ~0.37 is the most saturated sRGB colour. */
  readonly c: number;
  /** Hue angle in degrees, [0, 360). Meaningless (reported as 0) when chroma is 0. */
  readonly h: number;
}

export interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** Linear-light sRGB triple, each channel nominally 0–1. */
export type LinearRgb = readonly [number, number, number];

export class ColorParseError extends Error {
  constructor(value: string, reason: string) {
    super(`cannot parse colour ${JSON.stringify(value)}: ${reason}`);
    this.name = 'ColorParseError';
  }
}

/** CSS Color 4 named colours (the 148 keywords), as `#rrggbb`. `transparent` is separate. */
const NAMED_COLORS: Readonly<Record<string, string>> = Object.fromEntries(
  (
    'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff ' +
    'beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff ' +
    'blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 ' +
    'chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c ' +
    'cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 ' +
    'darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b ' +
    'darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 ' +
    'darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f ' +
    'darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 ' +
    'deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 ' +
    'floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ' +
    'ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 ' +
    'greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c ' +
    'indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 ' +
    'lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 ' +
    'lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 ' +
    'lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa ' +
    'lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 ' +
    'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 ' +
    'magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd ' +
    'mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 ' +
    'mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc ' +
    'mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 ' +
    'moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 ' +
    'olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa ' +
    'palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 ' +
    'peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 ' +
    'purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 ' +
    'saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee ' +
    'sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 ' +
    'slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c ' +
    'teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee ' +
    'wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32'
  )
    .split(' ')
    .reduce<[string, string][]>((pairs, token, index, tokens) => {
      if (index % 2 === 0) pairs.push([token, `#${tokens[index + 1] ?? ''}`]);
      return pairs;
    }, []),
);

/** Whether `word` (case-insensitive) is a CSS colour keyword this module can parse. */
export function isNamedColor(word: string): boolean {
  const lower = word.toLowerCase();
  return lower === 'transparent' || Object.hasOwn(NAMED_COLORS, lower);
}

function parseHex(value: string, body: string): Rgba {
  if (!/^[0-9a-f]+$/iu.test(body) || ![3, 4, 6, 8].includes(body.length)) {
    throw new ColorParseError(value, 'hex colours have 3, 4, 6 or 8 hex digits');
  }
  const full = body.length <= 4 ? [...body].map((digit) => digit + digit).join('') : body;
  const channel = (index: number): number =>
    Number.parseInt(full.slice(index * 2, index * 2 + 2), 16);
  return {
    r: channel(0),
    g: channel(1),
    b: channel(2),
    a: full.length === 8 ? channel(3) / 255 : 1,
  };
}

/** Splits `rgb(1, 2, 3)`, `rgb(1 2 3 / 50%)` and the like into their argument strings. */
function functionArguments(value: string, args: string): string[] {
  const [channels = '', alpha, extra] = args.split('/');
  if (extra !== undefined) throw new ColorParseError(value, 'more than one "/"');
  const parts = channels.includes(',')
    ? channels.split(',').map((part) => part.trim())
    : channels.trim().split(/\s+/u);
  if (alpha !== undefined) parts.push(alpha.trim());
  if (parts.some((part) => part === '')) throw new ColorParseError(value, 'empty argument');
  return parts;
}

function number(value: string, text: string): number {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/iu.test(text)) {
    throw new ColorParseError(value, `${JSON.stringify(text)} is not a number`);
  }
  return Number(text);
}

function alphaOf(value: string, text: string | undefined): number {
  if (text === undefined) return 1;
  const alpha = text.endsWith('%') ? number(value, text.slice(0, -1)) / 100 : number(value, text);
  if (alpha < 0 || alpha > 1) throw new ColorParseError(value, 'alpha outside [0, 1]');
  return alpha;
}

function parseRgbFunction(value: string, args: string): Rgba {
  const parts = functionArguments(value, args);
  if (parts.length !== 3 && parts.length !== 4) {
    throw new ColorParseError(value, 'rgb() takes 3 channels and an optional alpha');
  }
  const channel = (text: string): number => {
    const n = text.endsWith('%')
      ? (number(value, text.slice(0, -1)) / 100) * 255
      : number(value, text);
    if (n < 0 || n > 255) throw new ColorParseError(value, 'channel outside [0, 255]');
    return n;
  };
  return {
    r: channel(parts[0] ?? ''),
    g: channel(parts[1] ?? ''),
    b: channel(parts[2] ?? ''),
    a: alphaOf(value, parts[3]),
  };
}

function parseHslFunction(value: string, args: string): Rgba {
  const parts = functionArguments(value, args);
  if (parts.length !== 3 && parts.length !== 4) {
    throw new ColorParseError(value, 'hsl() takes 3 channels and an optional alpha');
  }
  const hueText = (parts[0] ?? '').replace(/deg$/u, '');
  const percent = (text: string): number => {
    if (!text.endsWith('%')) throw new ColorParseError(value, 'saturation/lightness need "%"');
    return number(value, text.slice(0, -1)) / 100;
  };
  const hue = (((number(value, hueText) % 360) + 360) % 360) / 360;
  const s = percent(parts[1] ?? '');
  const l = percent(parts[2] ?? '');
  // CSS Color 4 §7.1 reference algorithm.
  const f = (n: number): number => {
    const k = (n + hue * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: alphaOf(value, parts[3]) };
}

/**
 * Parses a CSS / MapLibre colour string. Throws {@link ColorParseError} on any syntax it
 * does not implement — never returns a guess.
 */
export function parseColor(value: string): Rgba {
  const text = value.trim().toLowerCase();
  if (text.startsWith('#')) return parseHex(value, text.slice(1));
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED_COLORS[text];
  if (named !== undefined) return parseHex(value, named.slice(1));
  const call = /^([a-z-]+)\((.*)\)$/su.exec(text);
  if (call !== null) {
    const [, name = '', args = ''] = call;
    if (name === 'rgb' || name === 'rgba') return parseRgbFunction(value, args);
    if (name === 'hsl' || name === 'hsla') return parseHslFunction(value, args);
    throw new ColorParseError(value, `${name}() is not implemented by this parser`);
  }
  throw new ColorParseError(value, 'unrecognised syntax');
}

/** Canonical `#rrggbb` / `#rrggbbaa` form, for comparing colours written differently. */
export function formatHex({ r, g, b, a }: Rgba): string {
  const hex = (n: number): string =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(a * 255) : ''}`;
}

/** sRGB transfer function, inverted (IEC 61966-2-1). */
export function toLinear({ r, g, b }: Rgba): LinearRgb {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [channel(r), channel(g), channel(b)];
}

/** sRGB transfer function; clamps first, so an out-of-gamut simulation stays displayable. */
export function fromLinear([r, g, b]: LinearRgb, a = 1): Rgba {
  const channel = (c: number): number => {
    const v = Math.min(1, Math.max(0, c));
    return (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
  };
  return { r: channel(r), g: channel(g), b: channel(b), a };
}

/** OKLab → OKLCH from linear sRGB (Ottosson 2020, the matrices CSS Color 4 adopts). */
export function linearToOklch([r, g, b]: LinearRgb): Oklch {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const oa = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const ob = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(oa, ob);
  const h = c < 1e-7 ? 0 : ((Math.atan2(ob, oa) * 180) / Math.PI + 360) % 360;
  return { l: lightness, c, h };
}

export function toOklch(color: Rgba): Oklch {
  return linearToOklch(toLinear(color));
}

/** CIELAB under D65 (the sRGB white), via XYZ with the IEC 61966-2-1 matrix. */
export function linearToLab([r, g, b]: LinearRgb): Lab {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const epsilon = (6 / 29) ** 3;
  const f = (t: number): number => (t > epsilon ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  return { l: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

export function toLab(color: Rgba): Lab {
  return linearToLab(toLinear(color));
}

/**
 * CIEDE2000 colour difference (kL = kC = kH = 1), per Sharma, Wu & Dalal 2005 — the
 * formulation whose published test pairs `color.test.ts` checks against.
 */
export function deltaE2000(first: Lab, second: Lab): number {
  const rad = Math.PI / 180;
  const c1 = Math.hypot(first.a, first.b);
  const c2 = Math.hypot(second.a, second.b);
  const cBar7 = ((c1 + c2) / 2) ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));
  const a1 = (1 + g) * first.a;
  const a2 = (1 + g) * second.a;
  const cp1 = Math.hypot(a1, first.b);
  const cp2 = Math.hypot(a2, second.b);
  const hue = (b: number, a: number): number =>
    b === 0 && a === 0 ? 0 : (((Math.atan2(b, a) / rad) % 360) + 360) % 360;
  const hp1 = hue(first.b, a1);
  const hp2 = hue(second.b, a2);

  const dL = second.l - first.l;
  const dC = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * rad);

  const lBar = (first.l + second.l) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hBar /= 2;
    else hBar = hp1 + hp2 < 360 ? (hBar + 360) / 2 : (hBar - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * rad) +
    0.24 * Math.cos(2 * hBar * rad) +
    0.32 * Math.cos((3 * hBar + 6) * rad) -
    0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const cpBar7 = cpBar ** 7;
  const rC = 2 * Math.sqrt(cpBar7 / (cpBar7 + 25 ** 7));
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cpBar;
  const sH = 1 + 0.015 * cpBar * t;
  const rT = -Math.sin(2 * dTheta * rad) * rC;
  return Math.sqrt((dL / sL) ** 2 + (dC / sC) ** 2 + (dH / sH) ** 2 + rT * (dC / sC) * (dH / sH));
}
