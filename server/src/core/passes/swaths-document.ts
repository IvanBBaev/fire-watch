/**
 * The `/overlays/passes/swaths.json` document (TASKS F15, the map half): one GeoJSON
 * FeatureCollection for the whole polled box holding, per platform, the swath footprint and
 * ground track of every pass over the box from {@link SWATH_RECENT_MS} back to
 * {@link SWATH_UPCOMING_MS} ahead of the bucket.
 *
 * One document for the whole box rather than per cell: the geometry does not depend on
 * where the reader looks, so a per-viewport product would multiply cache entries without
 * saying anything more — and a request that names no place says nothing about a reader.
 *
 * Pure and deterministic like `passes-document.ts`: the same bucket and elements always
 * produce the same bytes, so the route's ETag is a content hash. The foreign members
 * (`schema_version`, `computed_for`, `window`, `predicted`, `elements_provider`,
 * `platforms`) sit beside `features` — RFC 7946 §6.1 allows them and MapLibre ignores them
 * — so the one body is both the map source and its own provenance.
 *
 * ## Honest about its inputs
 *
 * `predicted: true` and each platform's element state and epoch travel with the geometry,
 * as in the per-cell document; a platform whose elements are missing is listed with no
 * features rather than dropped. `kind` splits the drawing: `recent` (mid before the bucket)
 * and `next` (mid at or after it), so the web can draw "where they looked" and "where they
 * will look" differently without re-deriving time.
 */

import type { EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { BoundingBox } from '../config/polling-bbox.js';
import { satrecFromOmm } from './omm.js';
import type { GroundPoint } from './pass-compute.js';
import type { PassInstrument, PassPlatformId } from './pass-platforms.js';
import { elementsState, type ElementsState, type PlatformElements } from './passes-document.js';
import { computeSwathPasses, type SwathPass } from './swath-geometry.js';

export const SWATHS_SCHEMA_VERSION = 1;

/** "Where they looked": long enough to cover the last day or night overpass group. */
export const SWATH_RECENT_MS = 6 * 3_600_000;

/** "Where they will look": the next day and night group, and no further. */
export const SWATH_UPCOMING_MS = 12 * 3_600_000;

/** ~100 m: far below what a 3 000 km swath drawn at country scale can show. */
const COORDINATE_DECIMALS = 3;

export type SwathKind = 'recent' | 'next';

export type SwathPart = 'swath' | 'track' | 'label';

export interface SwathFeatureProperties {
  readonly platform: PassPlatformId;
  readonly instrument: PassInstrument;
  readonly kind: SwathKind;
  readonly part: SwathPart;
  readonly start: string;
  readonly mid: string;
  readonly end: string;
}

type Position = readonly [number, number];

export type SwathGeometry =
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Position[])[] }
  | { readonly type: 'LineString'; readonly coordinates: readonly Position[] }
  | { readonly type: 'Point'; readonly coordinates: Position };

export interface SwathFeature {
  readonly type: 'Feature';
  readonly properties: SwathFeatureProperties;
  readonly geometry: SwathGeometry;
}

export interface SwathPlatformWire {
  readonly id: PassPlatformId;
  readonly instrument: PassInstrument;
  readonly swath_km: number;
  readonly elements: ElementsState;
  readonly elements_epoch: string | null;
}

export interface SwathsDocument {
  readonly type: 'FeatureCollection';
  readonly schema_version: typeof SWATHS_SCHEMA_VERSION;
  readonly computed_for: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly predicted: true;
  readonly elements_provider: 'celestrak';
  /** `[west, south, east, north]` — the box the passes were selected against. */
  readonly bbox: readonly [number, number, number, number];
  readonly platforms: readonly SwathPlatformWire[];
  readonly features: readonly SwathFeature[];
}

export function swathWindowFor(bucketMs: EpochMs): { fromMs: EpochMs; toMs: EpochMs } {
  return { fromMs: bucketMs - SWATH_RECENT_MS, toMs: bucketMs + SWATH_UPCOMING_MS };
}

const SCALE = 10 ** COORDINATE_DECIMALS;
const round = (value: number): number => Math.round(value * SCALE) / SCALE;
const position = (point: GroundPoint): Position => [round(point.lon), round(point.lat)];

function featuresOf(
  pass: SwathPass,
  platform: PlatformElements['platform'],
  bucketMs: EpochMs,
): SwathFeature[] {
  const base = {
    platform: platform.id,
    instrument: platform.instrument,
    kind: pass.midMs < bucketMs ? ('recent' as const) : ('next' as const),
    start: isoFromEpochMs(pass.startMs),
    mid: isoFromEpochMs(pass.midMs),
    end: isoFromEpochMs(pass.endMs),
  };
  const ring = [...pass.left, ...[...pass.right].reverse(), pass.left[0]!].map(position);
  return [
    {
      type: 'Feature',
      properties: { ...base, part: 'swath' },
      geometry: { type: 'Polygon', coordinates: [ring] },
    },
    {
      type: 'Feature',
      properties: { ...base, part: 'track' },
      geometry: { type: 'LineString', coordinates: pass.track.map(position) },
    },
    {
      type: 'Feature',
      properties: { ...base, part: 'label' },
      geometry: { type: 'Point', coordinates: position(pass.labelAt) },
    },
  ];
}

export function buildSwathsDocument(
  box: BoundingBox,
  bucketMs: EpochMs,
  elements: readonly PlatformElements[],
): SwathsDocument {
  const window = swathWindowFor(bucketMs);
  const platforms: SwathPlatformWire[] = [];
  const passes: { readonly order: number; readonly features: SwathFeature[]; mid: number }[] = [];
  elements.forEach(({ platform, record }, order) => {
    platforms.push({
      id: platform.id,
      instrument: platform.instrument,
      swath_km: platform.swathKm,
      elements: record === null ? 'missing' : elementsState(record.epochMs, bucketMs),
      elements_epoch:
        record === null ? null : isoFromEpochMs(Math.round(record.epochMs / 1000) * 1000),
    });
    if (record === null) return;
    for (const pass of computeSwathPasses(satrecFromOmm(record), box, window, platform.swathKm)) {
      passes.push({ order, mid: pass.midMs, features: featuresOf(pass, platform, bucketMs) });
    }
  });
  // Time order, platform order on a tie: the drawing order is then the same every bucket.
  passes.sort((a, b) => a.mid - b.mid || a.order - b.order);
  return {
    type: 'FeatureCollection',
    schema_version: SWATHS_SCHEMA_VERSION,
    computed_for: isoFromEpochMs(bucketMs),
    window: { from: isoFromEpochMs(window.fromMs), to: isoFromEpochMs(window.toMs) },
    predicted: true,
    elements_provider: 'celestrak',
    bbox: [box.west, box.south, box.east, box.north],
    platforms,
    features: passes.flatMap((pass) => pass.features),
  };
}
