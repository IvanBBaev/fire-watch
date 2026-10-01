/**
 * The F15 swath overlay, the pure half: what `/overlays/passes/swaths.json` (or the
 * committed fixture) is, how it is validated, and which of its passes the map draws at a
 * given moment.
 *
 * The browser never computes an orbit: the server runs SGP4 and draws the ground track and
 * the swath edges (`server/src/core/passes/swaths-document.ts`); this module only reads
 * them. The body is one GeoJSON FeatureCollection whose foreign members say what it is — a
 * prediction (`predicted: true`), from which elements, for which window.
 *
 * ## "Recent" and "next" are decided here, against the reader's clock
 *
 * The server tags each pass `recent` or `next` against the 10-minute bucket it computed for.
 * The map re-decides against `nowMs` instead ({@link swathsForDisplay}): a pass is **next**
 * while its mid-time is ahead, **recent** for {@link SWATH_RECENT_MS} after it, and not drawn
 * at all outside that — so a copy held for a while (or the fixtures build, whose document
 * is for a fixed moment) never outlines as "next" a pass that has already flown, and a
 * document whose window is over draws nothing rather than yesterday's sky.
 */

import { PASS_PLATFORM_LABELS, type ElementsState, type PassPlatformId } from './passes.js';

/**
 * "Where they will look": a blue outline, no fill — nothing has been seen there yet. Here,
 * not in `map/`, because the Layers panel legend paints the same swatch without loading
 * the map chunk. Never red or orange: fire owns those (CI-14).
 */
export const PASS_NEXT_COLOR = '#2563eb';
/** "Where they looked": violet, a faint fill and a thin edge. */
export const PASS_RECENT_COLOR = '#7c3aed';

/** Mirrors the server's `SWATH_RECENT_MS`: "where they looked" reaches back six hours. */
export const SWATH_RECENT_MS = 6 * 3_600_000;

export type SwathKind = 'recent' | 'next';
export type SwathPart = 'swath' | 'track' | 'label';

type Position = readonly [number, number];

export type SwathGeometry =
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Position[])[] }
  | { readonly type: 'LineString'; readonly coordinates: readonly Position[] }
  | { readonly type: 'Point'; readonly coordinates: Position };

export interface SwathFeature {
  readonly type: 'Feature';
  readonly properties: {
    readonly platform: PassPlatformId;
    readonly instrument: 'viirs' | 'slstr';
    readonly kind: SwathKind;
    readonly part: SwathPart;
    readonly start: string;
    readonly mid: string;
    readonly end: string;
  };
  readonly geometry: SwathGeometry;
}

export interface SwathPlatform {
  readonly id: PassPlatformId;
  readonly elements: ElementsState;
  readonly elements_epoch: string | null;
}

/** The wire shape, as the route and the fixture spell it (only what the web reads). */
export interface PassSwathsDoc {
  readonly type: 'FeatureCollection';
  readonly schema_version: 1;
  readonly computed_for: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly predicted: true;
  readonly elements_provider: 'celestrak';
  readonly platforms: readonly SwathPlatform[];
  readonly features: readonly SwathFeature[];
}

// ── Validation ──────────────────────────────────────────────────────────────

const PLATFORM_IDS = new Set<string>(Object.keys(PASS_PLATFORM_LABELS));

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
  Number.isFinite(Date.parse(value));

const isPosition = (value: unknown): value is Position =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((n) => typeof n === 'number' && Number.isFinite(n));

const isLine = (value: unknown, min: number): value is readonly Position[] =>
  Array.isArray(value) && value.length >= min && value.every(isPosition);

function parseGeometry(part: SwathPart, value: unknown): SwathGeometry | null {
  if (!isRecord(value)) return null;
  const { type, coordinates } = value;
  if (part === 'swath' && type === 'Polygon') {
    return Array.isArray(coordinates) && coordinates.length === 1 && isLine(coordinates[0], 4)
      ? { type, coordinates: coordinates as readonly (readonly Position[])[] }
      : null;
  }
  if (part === 'track' && type === 'LineString') {
    return isLine(coordinates, 2) ? { type, coordinates } : null;
  }
  if (part === 'label' && type === 'Point') {
    return isPosition(coordinates) ? { type, coordinates } : null;
  }
  return null;
}

function parseFeature(value: unknown): SwathFeature | null {
  if (!isRecord(value) || value['type'] !== 'Feature' || !isRecord(value['properties'])) {
    return null;
  }
  const { platform, instrument, kind, part, start, mid, end } = value['properties'];
  if (typeof platform !== 'string' || !PLATFORM_IDS.has(platform)) return null;
  if (instrument !== 'viirs' && instrument !== 'slstr') return null;
  if (kind !== 'recent' && kind !== 'next') return null;
  if (part !== 'swath' && part !== 'track' && part !== 'label') return null;
  if (!isInstant(start) || !isInstant(mid) || !isInstant(end)) return null;
  const geometry = parseGeometry(part, value['geometry']);
  if (geometry === null) return null;
  return {
    type: 'Feature',
    properties: {
      platform: platform as PassPlatformId,
      instrument,
      kind,
      part,
      start,
      mid,
      end,
    },
    geometry,
  };
}

function parsePlatform(value: unknown): SwathPlatform | null {
  if (!isRecord(value)) return null;
  const { id, elements, elements_epoch } = value;
  if (typeof id !== 'string' || !PLATFORM_IDS.has(id)) return null;
  if (elements !== 'current' && elements !== 'stale' && elements !== 'missing') return null;
  if (elements_epoch !== null && !isInstant(elements_epoch)) return null;
  return { id: id as PassPlatformId, elements, elements_epoch };
}

function parseAll<T>(value: unknown, parse: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const entry of value as unknown[]) {
    const parsed = parse(entry);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * A body → the document, or `null` for anything that is not exactly schema 1. Strict on
 * purpose, like `parsePassesDocument`: a half-understood prediction would be drawn as a
 * fact about the sky.
 */
export function parsePassSwaths(value: unknown): PassSwathsDoc | null {
  if (!isRecord(value) || value['type'] !== 'FeatureCollection') return null;
  if (value['schema_version'] !== 1 || value['predicted'] !== true) return null;
  if (value['elements_provider'] !== 'celestrak') return null;
  const { computed_for, window } = value;
  if (!isInstant(computed_for)) return null;
  if (!isRecord(window) || !isInstant(window['from']) || !isInstant(window['to'])) return null;
  const platforms = parseAll(value['platforms'], parsePlatform);
  const features = parseAll(value['features'], parseFeature);
  if (platforms === null || features === null) return null;
  return {
    type: 'FeatureCollection',
    schema_version: 1,
    computed_for,
    window: { from: window['from'], to: window['to'] },
    predicted: true,
    elements_provider: 'celestrak',
    platforms,
    features,
  };
}

// ── What is drawn now ───────────────────────────────────────────────────────

/** The platform's short name for a map label: "NOAA-20", not "NOAA-20 · VIIRS". */
export function platformShortName(id: PassPlatformId): string {
  return PASS_PLATFORM_LABELS[id].split(' · ')[0] ?? id;
}

/** One pass as the panel lists it: which platform, when (mid), recent or next. */
export interface SwathPassSummary {
  readonly platform: PassPlatformId;
  readonly mid: string;
  readonly kind: SwathKind;
}

export interface SwathDisplay {
  /** What the map source takes: the drawn features, each with its `kind` and `label`. */
  readonly collection: {
    readonly type: 'FeatureCollection';
    readonly features: readonly {
      readonly type: 'Feature';
      readonly properties: SwathFeature['properties'] & { readonly label: string };
      readonly geometry: SwathGeometry;
    }[];
  };
  /** The drawn passes, in time order — the panel's list, and the map's labels in words. */
  readonly passes: readonly SwathPassSummary[];
  /** The document's window is over: nothing ahead of `nowMs` was ever computed. */
  readonly ended: boolean;
}

/** `kind` against `nowMs` (see the module note), or `null` when the pass is not drawn. */
export function kindAt(midIso: string, nowMs: number): SwathKind | null {
  const mid = Date.parse(midIso);
  if (mid >= nowMs) return 'next';
  return nowMs - mid <= SWATH_RECENT_MS ? 'recent' : null;
}

/**
 * The features to draw at `nowMs`, re-tagged `recent` / `next` against it and labelled
 * "<platform> <local time>" by `formatTime` (the caller's Sofia `HH:MM` formatter). Pure.
 */
export function swathsForDisplay(
  doc: PassSwathsDoc,
  nowMs: number,
  formatTime: (iso: string) => string,
): SwathDisplay {
  const features: SwathDisplay['collection']['features'][number][] = [];
  const passes: SwathPassSummary[] = [];
  for (const feature of doc.features) {
    const kind = kindAt(feature.properties.mid, nowMs);
    if (kind === null) continue;
    const { platform, mid } = feature.properties;
    if (feature.properties.part === 'swath') passes.push({ platform, mid, kind });
    features.push({
      type: 'Feature',
      properties: {
        ...feature.properties,
        kind,
        label: `${platformShortName(platform)} ${formatTime(mid)}`,
      },
      geometry: feature.geometry,
    });
  }
  return {
    collection: { type: 'FeatureCollection', features },
    passes,
    ended: Date.parse(doc.window.to) <= nowMs,
  };
}

/** What the shell hands the map controller: the drawn collection and the credit to show. */
export interface PassSwathsDraw {
  readonly collection: SwathDisplay['collection'];
  /** The CelesTrak credit, rendered from the contracts registry (`celestrak`). */
  readonly attribution: string;
}
