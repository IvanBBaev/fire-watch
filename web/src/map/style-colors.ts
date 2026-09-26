/**
 * The map half of the CI-14 "fire owns red" gate (review 06 §5.4, ADR-005 D4): reads every
 * colour a MapLibre style can paint, and checks the fire palette under colour-vision
 * deficiency.
 *
 * Pure and structural — layers arrive as plain objects, so the gate can feed it the
 * runtime registry (through fake hosts) and any style JSON alike. No `maplibre-gl` import,
 * not even as a type: nothing here depends on its version.
 *
 * **Classification is by name, never by position.** A layer is fire-owned when its id
 * carries the reserved `fire-` / `alert-` prefix (06 §5.4, 08 §5.7.4); a pattern image is
 * fire-owned under the `fire-` prefix the hatch ids already use. Membership in the registry
 * is deliberately *not* enough: the prefix is what a basemap author, a reviewer and the
 * lint can all see.
 *
 * **Unknown means red.** An expression operator the walker does not know, a colour string
 * it cannot parse, or a pattern naming an image nobody registered throws. A lint that
 * skips what it cannot read reports "clean" for exactly the colours nobody checked.
 */

import type { Oklch, Rgba } from '../core/color/color.js';
import { deltaE2000, formatHex, parseColor, toLab, toOklch } from '../core/color/color.js';
import type { CvdKind } from '../core/color/cvd.js';
import { CVD_KINDS, simulateCvd } from '../core/color/cvd.js';

/** 06 §5.4: layers under these prefixes may use red/orange; nothing else may. */
export const FIRE_OWNED_LAYER_ID = /^(?:fire|alert)-/u;
/** Runtime pattern images share the prefix the registry's hatch ids use. */
export const FIRE_OWNED_IMAGE_ID = /^fire-/u;

/** 06 §5.4: the reserved hue bands, in OKLCH degrees, inclusive. */
export const FIRE_HUE_BANDS: ReadonlyArray<readonly [number, number]> = [
  [20, 55],
  [350, 360],
];
/** 06 §5.4: below this OKLCH chroma a colour is a neutral, whatever its nominal hue. */
export const FIRE_CHROMA_FLOOR = 0.09;
/** 06 §5.4 / 07 §5.8.1: minimum CIEDE2000 between two fire classes under each simulation. */
export const MIN_CVD_DELTA_E00 = 15;
/**
 * The "color-or-shape" escape (06 §5.4): two classes whose colours collapse under CVD are
 * still told apart when their size differs by at least this ratio. The spec names the
 * channel ("distinct circle-radius/symbol per class") but not the amount — 1.2 is our
 * choice, roughly the smallest radius step that reads without side-by-side comparison.
 */
export const MIN_SIZE_RATIO = 1.2;

/**
 * 06 §5.4: "thresholds and a documented exemption list (expected: none)". Keys are
 * `layerId property #rrggbb`. Empty, as the spec expects; a finding belongs in the gate's
 * known-findings register, not here.
 */
export const HUE_EXEMPTIONS: ReadonlySet<string> = new Set<string>();

export function isFireOwnedLayerId(id: string): boolean {
  return FIRE_OWNED_LAYER_ID.test(id);
}

export function isFireOwnedImageId(id: string): boolean {
  return FIRE_OWNED_IMAGE_ID.test(id);
}

/** True when `color` sits in a reserved hue band with more than the chroma floor. */
export function isFireHue(color: Rgba): boolean {
  const { c, h }: Oklch = toOklch(color);
  if (c <= FIRE_CHROMA_FLOOR) return false;
  return FIRE_HUE_BANDS.some(([low, high]) => h >= low && h <= high);
}

export class StyleColorError extends Error {
  constructor(where: string, reason: string) {
    super(`${where}: ${reason}`);
    this.name = 'StyleColorError';
  }
}

/** The slice of a style layer the gate reads. */
export interface StyleLayerLike {
  readonly id: string;
  readonly type: string;
  readonly minzoom?: number;
  readonly paint?: Readonly<Record<string, unknown>>;
  readonly layout?: Readonly<Record<string, unknown>>;
}

/** Colours per registered image id — every opaque pixel colour in the tile. */
export type ImageColors = ReadonlyMap<string, readonly Rgba[]>;

/** A property that paints a colour (`fill-color`, `circle-stroke-color`, `heatmap-color`, …). */
export function isColorProperty(property: string): boolean {
  return property.endsWith('-color');
}

/** A property that paints a registered image (`fill-pattern`, `line-pattern`, …). */
export function isPatternProperty(property: string): boolean {
  return property.endsWith('-pattern');
}

/** Every opaque pixel colour of an RGBA buffer — what a pattern tile actually paints. */
export function opaqueColors(data: Uint8Array): Rgba[] {
  const seen = new Map<string, Rgba>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    if ((data[i + 3] ?? 0) === 0) continue;
    const color: Rgba = {
      r: data[i] ?? 0,
      g: data[i + 1] ?? 0,
      b: data[i + 2] ?? 0,
      a: (data[i + 3] ?? 0) / 255,
    };
    seen.set(formatHex(color), color);
  }
  return [...seen.values()];
}

/**
 * The leaves an expression can output — the values it can return, not the ones it reads.
 * Only the branching operators are traversed; everything else is a leaf, and it is the
 * caller's resolver that decides whether a leaf is readable.
 */
function outputLeaves(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) return [value];
  const [op, ...args] = value as unknown[];
  switch (op) {
    case 'match': {
      // [match, input, label, out, label, out, …, fallback]
      const outs = args.slice(1);
      return outs.flatMap((arg, i) =>
        i % 2 === 1 || i === outs.length - 1 ? outputLeaves(arg, where) : [],
      );
    }
    case 'case': {
      // [case, cond, out, cond, out, …, fallback]
      return args.flatMap((arg, i) =>
        i % 2 === 1 || i === args.length - 1 ? outputLeaves(arg, where) : [],
      );
    }
    case 'interpolate':
    case 'interpolate-hcl':
    case 'interpolate-lab': {
      // [op, type, input, stop, out, stop, out, …]
      return args.slice(2).flatMap((arg, i) => (i % 2 === 1 ? outputLeaves(arg, where) : []));
    }
    case 'step': {
      // [step, input, out0, stop, out, …]
      return args.slice(1).flatMap((arg, i) => (i % 2 === 0 ? outputLeaves(arg, where) : []));
    }
    case 'coalesce':
      return args.flatMap((arg) => outputLeaves(arg, where));
    case 'literal':
      return [args[0]];
    default:
      return [value];
  }
}

function colorLeaf(leaf: unknown, where: string): Rgba {
  if (typeof leaf === 'string') {
    try {
      return parseColor(leaf);
    } catch (error) {
      throw new StyleColorError(where, error instanceof Error ? error.message : String(error));
    }
  }
  if (Array.isArray(leaf) && (leaf[0] === 'rgb' || leaf[0] === 'rgba')) {
    const channels = leaf.slice(1);
    if (channels.every((channel): channel is number => typeof channel === 'number')) {
      const [r = 0, g = 0, b = 0, a = 1] = channels;
      return { r, g, b, a };
    }
  }
  throw new StyleColorError(where, `cannot read a colour from ${JSON.stringify(leaf)}`);
}

/** Every colour a colour property can paint. Throws on anything it cannot read. */
export function colorOutputs(value: unknown, where: string): Rgba[] {
  return outputLeaves(value, where).map((leaf) => colorLeaf(leaf, where));
}

/** Every image id a pattern property can paint. Throws on anything but string ids. */
export function patternOutputs(value: unknown, where: string): string[] {
  return outputLeaves(value, where).map((leaf) => {
    if (typeof leaf !== 'string') {
      throw new StyleColorError(where, `cannot read an image id from ${JSON.stringify(leaf)}`);
    }
    return leaf;
  });
}

/** One colour a layer paints, with the path that paints it. */
export interface PaintedColor {
  readonly layerId: string;
  readonly property: string;
  readonly color: Rgba;
  /** Set when the colour comes from a pattern image. */
  readonly imageId?: string;
}

function paintEntries(layer: StyleLayerLike): Array<readonly [string, unknown]> {
  return [...Object.entries(layer.paint ?? {}), ...Object.entries(layer.layout ?? {})];
}

/** Every colour every layer can paint — the whole style, not a sample. */
export function paintedColors(
  layers: readonly StyleLayerLike[],
  images: ImageColors,
): PaintedColor[] {
  const out: PaintedColor[] = [];
  for (const layer of layers) {
    for (const [property, value] of paintEntries(layer)) {
      const where = `layer ${layer.id} ${property}`;
      if (isColorProperty(property)) {
        for (const color of colorOutputs(value, where)) {
          out.push({ layerId: layer.id, property, color });
        }
      } else if (isPatternProperty(property)) {
        for (const imageId of patternOutputs(value, where)) {
          const colors = images.get(imageId);
          if (colors === undefined) {
            throw new StyleColorError(where, `pattern names unregistered image ${imageId}`);
          }
          for (const color of colors) out.push({ layerId: layer.id, property, color, imageId });
        }
      }
    }
  }
  return out;
}

/** 06 §5.4 hue rule over the style: fire hues only on fire-owned layers. */
export function hueViolations(painted: readonly PaintedColor[]): PaintedColor[] {
  return painted.filter(
    (entry) =>
      !isFireOwnedLayerId(entry.layerId) &&
      isFireHue(entry.color) &&
      !HUE_EXEMPTIONS.has(`${entry.layerId} ${entry.property} ${formatHex(entry.color)}`),
  );
}

// ---------------------------------------------------------------------------------------
// Evaluation — just enough of the expression language to ask "what does class X paint".

export interface EvaluationContext {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly zoom: number;
  readonly featureState: Readonly<Record<string, unknown>>;
}

function interpolateLinear(input: number, stops: readonly unknown[], where: string): number {
  const pairs: Array<readonly [number, number]> = [];
  for (let i = 0; i + 1 < stops.length; i += 2) {
    const stop = stops[i];
    const out = stops[i + 1];
    if (typeof stop !== 'number' || typeof out !== 'number') {
      throw new StyleColorError(where, 'only numeric interpolation is evaluated');
    }
    pairs.push([stop, out]);
  }
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  if (first === undefined || last === undefined) throw new StyleColorError(where, 'no stops');
  if (input <= first[0]) return first[1];
  if (input >= last[0]) return last[1];
  for (let i = 1; i < pairs.length; i += 1) {
    const [x0, y0] = pairs[i - 1] ?? first;
    const [x1, y1] = pairs[i] ?? last;
    if (input <= x1) return y0 + ((input - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

function num(value: unknown, where: string): number {
  if (typeof value !== 'number')
    throw new StyleColorError(where, `expected a number, got ${JSON.stringify(value)}`);
  return value;
}

/** Evaluates an expression for one feature. Throws on any operator it does not implement. */
export function evaluate(expression: unknown, context: EvaluationContext, where: string): unknown {
  if (!Array.isArray(expression)) return expression;
  const [op, ...args] = expression as unknown[];
  const ev = (arg: unknown): unknown => evaluate(arg, context, where);
  switch (op) {
    case 'literal':
      return args[0];
    case 'get':
      return context.properties[String(args[0])] ?? null;
    case 'feature-state':
      return context.featureState[String(args[0])] ?? null;
    case 'zoom':
      return context.zoom;
    case '==':
      return ev(args[0]) === ev(args[1]);
    case '!=':
      return ev(args[0]) !== ev(args[1]);
    case 'boolean': {
      for (const arg of args) {
        const value = ev(arg);
        if (typeof value === 'boolean') return value;
      }
      throw new StyleColorError(where, 'boolean assertion failed');
    }
    case 'coalesce': {
      for (const arg of args) {
        const value = ev(arg);
        if (value !== null && value !== undefined) return value;
      }
      return null;
    }
    case 'case': {
      for (let i = 0; i + 1 < args.length; i += 2) {
        if (ev(args[i]) === true) return ev(args[i + 1]);
      }
      return ev(args[args.length - 1]);
    }
    case 'match': {
      const input = ev(args[0]);
      for (let i = 1; i < args.length - 1; i += 2) {
        const label = args[i];
        const hit = Array.isArray(label) ? label.includes(input) : label === input;
        if (hit) return ev(args[i + 1]);
      }
      return ev(args[args.length - 1]);
    }
    case 'interpolate': {
      const [type, input, ...stops] = args;
      if (!Array.isArray(type) || type[0] !== 'linear') {
        throw new StyleColorError(where, `only linear interpolation is evaluated`);
      }
      return interpolateLinear(num(ev(input), where), stops.map(ev), where);
    }
    case '*':
      return args.reduce<number>((product, arg) => product * num(ev(arg), where), 1);
    case '+':
      return args.reduce<number>((sum, arg) => sum + num(ev(arg), where), 0);
    default:
      throw new StyleColorError(where, `cannot evaluate operator ${JSON.stringify(op)}`);
  }
}

/** True when the value reads the feature — i.e. it can differ between classes. */
export function isDataDriven(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value[0] === 'get' || value[0] === 'feature-state') return true;
  return value.some(isDataDriven);
}

// ---------------------------------------------------------------------------------------
// CVD — 06 §5.4 / 07 §5.8.1.

/** One kind of fire, as the style sees it: a named set of feature properties. */
export interface FireClass {
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** The size channel per layer type — the "shape" half of "color-or-shape". */
const SIZE_PROPERTY: Readonly<Record<string, string>> = {
  circle: 'circle-radius',
  line: 'line-width',
  symbol: 'icon-size',
};

export interface CvdCollapse {
  readonly layerId: string;
  readonly property: string;
  /** The two colours, sorted by hex. */
  readonly colors: readonly [string, string];
  /** One class pair that paints them with no size difference to fall back on. */
  readonly classes: readonly [string, string];
  /** ΔE00 under each simulation that falls below {@link MIN_CVD_DELTA_E00}. */
  readonly failures: ReadonlyArray<readonly [CvdKind, number]>;
}

/** ΔE00 between two colours as a dichromat of `kind` sees them. Alpha is ignored. */
export function simulatedDeltaE(kind: CvdKind, first: Rgba, second: Rgba): number {
  return deltaE2000(toLab(simulateCvd(kind, first)), toLab(simulateCvd(kind, second)));
}

/**
 * For every data-driven colour or pattern property of every layer, every pair of classes
 * the style paints in *different* colours — i.e. a distinction the style means to draw —
 * that collapses below {@link MIN_CVD_DELTA_E00} under some simulation and is not rescued
 * by a size difference of at least {@link MIN_SIZE_RATIO}. One entry per colour pair.
 */
export function cvdCollapses(
  layers: readonly StyleLayerLike[],
  classes: readonly FireClass[],
  images: ImageColors,
): CvdCollapse[] {
  const out = new Map<string, CvdCollapse>();
  for (const layer of layers) {
    const zoom = layer.minzoom ?? 0;
    const sizeProperty = SIZE_PROPERTY[layer.type];
    const sizeValue =
      sizeProperty === undefined
        ? undefined
        : (layer.paint?.[sizeProperty] ?? layer.layout?.[sizeProperty]);
    for (const [property, value] of paintEntries(layer)) {
      const pattern = isPatternProperty(property);
      if (!(isColorProperty(property) || pattern) || !isDataDriven(value)) continue;
      const where = `layer ${layer.id} ${property}`;
      const painted = classes.map((fireClass) => {
        const context: EvaluationContext = {
          properties: fireClass.properties,
          zoom,
          featureState: { selected: false },
        };
        const raw = evaluate(value, context, where);
        let color: Rgba;
        if (pattern) {
          const colors = images.get(String(raw));
          if (colors?.length !== 1 || colors[0] === undefined) {
            throw new StyleColorError(where, `image ${String(raw)} must paint exactly one colour`);
          }
          color = colors[0];
        } else {
          color = colorLeaf(raw, where);
        }
        const size =
          sizeValue === undefined ? undefined : num(evaluate(sizeValue, context, where), where);
        return { name: fireClass.name, color, hex: formatHex({ ...color, a: 1 }), size };
      });
      for (let i = 0; i < painted.length; i += 1) {
        for (let j = i + 1; j < painted.length; j += 1) {
          const first = painted[i];
          const second = painted[j];
          if (first === undefined || second === undefined || first.hex === second.hex) continue;
          if (first.size !== undefined && second.size !== undefined) {
            const ratio = Math.max(first.size, second.size) / Math.min(first.size, second.size);
            if (ratio >= MIN_SIZE_RATIO) continue;
          }
          const [a, b] = first.hex < second.hex ? [first, second] : [second, first];
          const key = `${layer.id} ${property} ${a.hex} ${b.hex}`;
          if (out.has(key)) continue;
          const failures = CVD_KINDS.map(
            (kind) => [kind, simulatedDeltaE(kind, a.color, b.color)] as const,
          ).filter(([, deltaE]) => deltaE < MIN_CVD_DELTA_E00);
          if (failures.length === 0) continue;
          out.set(key, {
            layerId: layer.id,
            property,
            colors: [a.hex, b.hex],
            classes: [a.name, b.name],
            failures,
          });
        }
      }
    }
  }
  return [...out.values()];
}
