/**
 * The per-point FWI forecast lookup, days 0 … 9 (V2-B1) — the pure half.
 *
 * GWIS answers a keyless WMS `GetFeatureInfo` on `ecmwf.query` with a small HTML table
 * whose "Fire Weather Index (FWI)" row is the ECMWF-driven FWI value at the queried pixel
 * for one forecast day (`TIME=YYYY-MM-DD`). Past the forecast horizon it answers a 200
 * with an empty body. Everything that decides something lives here:
 *
 *   * **Which point.** The reader's coordinates are snapped to one decimal (~11 km, coarser
 *     than the ~8 km FWI grid it samples), and only a point inside `POLLING_BBOX` is ever
 *     asked about — the route refuses everything else before a socket opens.
 *   * **Which query.** The full GetFeatureInfo query is rendered here from the snapped
 *     point and the clock's date, so no reader-supplied string reaches the upstream.
 *   * **What the answer means.** `parseGwisFeatureInfo` reads the FWI row and nothing else;
 *     `fwiDangerClass` maps the value onto the six EFFIS classes, with the same thresholds
 *     the FWI raster's legend uses (`web/src/ui/layers.ts` `FWI_CLASSES`).
 *   * **When to ask again.** `createFwiForecastService` caches a point's ten days for an
 *     hour (the forecast is issued once a day), shares one in-flight lookup between
 *     concurrent readers, and caps how many upstream lookups an hour may cost.
 *
 * This is a relayed EFFIS/GWIS forecast. Nothing here predicts anything.
 */

import type { BoundingBox } from '../config/polling-bbox.js';
import { effisUtcDate } from '../config/effis-layers.js';
import type { Clock, EpochMs } from '../ports/clock.js';
import type { FwiPointClient } from '../ports/fwi-point-client.js';

/** D0 (today) … D9: the horizon GWIS `ecmwf.query` answers (verified 2026-10-23). */
export const FWI_POINT_LEAD_DAYS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** The six EFFIS FWI danger classes, lowest first. */
export const FWI_DANGER_CLASSES = [
  'very-low',
  'low',
  'moderate',
  'high',
  'very-high',
  'extreme',
] as const;

export type FwiDangerClass = (typeof FWI_DANGER_CLASSES)[number];

/**
 * The upper bound of every class but the last, in FWI units — EFFIS's published legend for
 * `mf010.fwi` and GWIS `ecmwf.fwi` (byte-identical legends, verified 2026-10-23).
 */
export const FWI_CLASS_UPPER_BOUNDS = [11.2, 21.3, 38.0, 50.0, 70.0] as const;

/** The class a value falls in; a value on a bound belongs to the class above it. */
export function fwiDangerClass(fwi: number): FwiDangerClass {
  for (let index = 0; index < FWI_CLASS_UPPER_BOUNDS.length; index += 1) {
    const upper = FWI_CLASS_UPPER_BOUNDS[index];
    if (upper !== undefined && fwi < upper) return FWI_DANGER_CLASSES[index] ?? 'extreme';
  }
  return 'extreme';
}

export type GwisFeatureInfo =
  | { readonly kind: 'value'; readonly fwi: number }
  /** The empty 200 GWIS answers past its horizon or off its grid. */
  | { readonly kind: 'no-data' }
  /** Anything else: a changed page, an error document, a negative or absurd number. */
  | { readonly kind: 'unparseable' };

const FWI_ROW_RE =
  /<td>\s*Fire Weather Index \(FWI\)\s*<\/td>\s*<td>\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*<\/td>/;

/** FWI is open-ended in principle, but a value past this is a broken answer, not weather. */
const MAX_PLAUSIBLE_FWI = 500;

/** Reads the FWI row of a GWIS `ecmwf.query` HTML answer. */
export function parseGwisFeatureInfo(body: string): GwisFeatureInfo {
  if (body.trim() === '') return { kind: 'no-data' };
  const match = FWI_ROW_RE.exec(body);
  const raw = match?.[1];
  if (raw === undefined) return { kind: 'unparseable' };
  const fwi = Number(raw);
  if (!Number.isFinite(fwi) || fwi < 0 || fwi > MAX_PLAUSIBLE_FWI) return { kind: 'unparseable' };
  return { kind: 'value', fwi };
}

/** A point snapped to one decimal, held as integer tenths so it never drifts. */
export interface SnappedPoint {
  readonly latTenths: number;
  readonly lonTenths: number;
}

/** `42.7` — the path-segment form the route accepts and the response echoes. */
export const SNAPPED_COORDINATE_RE = /^-?\d{1,3}\.\d$/;

/**
 * Parses the route's two path segments. Only the one-decimal form is accepted: a reader
 * who could send `42.71234` could make every request a cache miss.
 */
export function parseSnappedPoint(lat: string, lon: string): SnappedPoint | null {
  if (!SNAPPED_COORDINATE_RE.test(lat) || !SNAPPED_COORDINATE_RE.test(lon)) return null;
  const latTenths = Math.round(Number(lat) * 10);
  const lonTenths = Math.round(Number(lon) * 10);
  if (Math.abs(latTenths) > 900 || Math.abs(lonTenths) > 1800) return null;
  return { latTenths, lonTenths };
}

export function snappedLat(point: SnappedPoint): number {
  return point.latTenths / 10;
}

export function snappedLon(point: SnappedPoint): number {
  return point.lonTenths / 10;
}

export function pointInBox(point: SnappedPoint, box: BoundingBox): boolean {
  const lat = snappedLat(point);
  const lon = snappedLon(point);
  return lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;
}

function tenths(value: number): string {
  return (value / 10).toFixed(1);
}

/**
 * The GetFeatureInfo query for one point and one day, as ordered pairs. The box is 0.2°
 * around the point at 101×101 pixels, and the queried pixel is its centre (50, 50); WMS
 * 1.3.0 with `EPSG:4326` orders the box latitude first (see `effisLayerQuery`).
 */
export function gwisPointQuery(
  point: SnappedPoint,
  date: string,
): Readonly<Record<string, string>> {
  const bbox = [
    tenths(point.latTenths - 1),
    tenths(point.lonTenths - 1),
    tenths(point.latTenths + 1),
    tenths(point.lonTenths + 1),
  ].join(',');
  return Object.freeze({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetFeatureInfo',
    LAYERS: 'ecmwf.query',
    QUERY_LAYERS: 'ecmwf.query',
    STYLES: '',
    CRS: 'EPSG:4326',
    BBOX: bbox,
    WIDTH: '101',
    HEIGHT: '101',
    I: '50',
    J: '50',
    INFO_FORMAT: 'text/html',
    TIME: date,
  });
}

export interface FwiForecastDay {
  /** The UTC date the value is forecast for. */
  readonly date: string;
  readonly lead_days: number;
  /** The relayed FWI value, or `null` when GWIS had none for this day. */
  readonly fwi: number | null;
  readonly danger_class: FwiDangerClass | null;
}

export interface FwiForecastPoint {
  readonly schema_version: 1;
  readonly lat: number;
  readonly lon: number;
  /** The UTC date of day 0 — the date the lookup ran on. */
  readonly base_date: string;
  /** When the upstream answers were in our hands (ISO). */
  readonly fetched_at: string;
  readonly days: readonly FwiForecastDay[];
}

export type FwiForecastLookup =
  | { readonly ok: true; readonly body: FwiForecastPoint }
  /** Every day failed or was unparseable: nothing honest to show. */
  | { readonly ok: false; readonly reason: 'upstream_failed' | 'budget_exhausted' };

const DAY_MS = 86_400_000;

/** Asks GWIS for all ten days of one point. Pure apart from the injected client and clock. */
export async function lookupFwiForecast(
  client: FwiPointClient,
  clock: Clock,
  point: SnappedPoint,
): Promise<FwiForecastLookup> {
  const now = clock.now();
  const answers = await Promise.all(
    FWI_POINT_LEAD_DAYS.map(async (lead) => {
      const date = effisUtcDate(now + lead * DAY_MS);
      const fetched = await client.fetchPoint({ query: gwisPointQuery(point, date) });
      return { lead, date, fetched };
    }),
  );
  let anyAnswer = false;
  const days: FwiForecastDay[] = answers.map(({ lead, date, fetched }) => {
    if (fetched.body === null) return { date, lead_days: lead, fwi: null, danger_class: null };
    const parsed = parseGwisFeatureInfo(fetched.body);
    if (parsed.kind === 'unparseable') {
      return { date, lead_days: lead, fwi: null, danger_class: null };
    }
    anyAnswer = true;
    if (parsed.kind === 'no-data') return { date, lead_days: lead, fwi: null, danger_class: null };
    return {
      date,
      lead_days: lead,
      fwi: Math.round(parsed.fwi * 10) / 10,
      danger_class: fwiDangerClass(parsed.fwi),
    };
  });
  if (!anyAnswer || days.every((day) => day.fwi === null)) {
    return { ok: false, reason: 'upstream_failed' };
  }
  return {
    ok: true,
    body: {
      schema_version: 1,
      lat: snappedLat(point),
      lon: snappedLon(point),
      base_date: effisUtcDate(now),
      fetched_at: new Date(clock.now()).toISOString(),
      days,
    },
  };
}

export interface FwiForecastServiceOptions {
  readonly client: FwiPointClient;
  readonly clock: Clock;
  /** How long a point's answer is reused. One hour: GWIS issues the forecast daily. */
  readonly ttlMs?: number;
  /** Bounded, because the key space is chosen by strangers. */
  readonly maxEntries?: number;
  /** Upstream lookups (each ten GetFeatureInfo requests) allowed per budget window. */
  readonly upstreamBudget?: number;
  readonly upstreamWindowMs?: number;
}

export interface FwiForecastService {
  lookup(point: SnappedPoint): Promise<FwiForecastLookup>;
}

export const DEFAULT_FWI_POINT_TTL_MS = 3_600_000;
export const DEFAULT_FWI_POINT_MAX_ENTRIES = 2_000;
/** 120 lookups an hour is 1 200 GetFeatureInfo requests: polite for an open service. */
export const DEFAULT_FWI_POINT_UPSTREAM_BUDGET = 120;
export const DEFAULT_FWI_POINT_UPSTREAM_WINDOW_MS = 3_600_000;

interface CacheEntry {
  readonly storedAt: EpochMs;
  readonly baseDate: string;
  readonly lookup: FwiForecastLookup;
}

/**
 * Cache + single-flight + global upstream budget around {@link lookupFwiForecast}. A
 * failure is cached for a tenth of the TTL so a GWIS outage costs one lookup per point
 * per few minutes, not one per reader. A cached answer never outlives its UTC day: at
 * midnight "day 0" moves and the old answer would be off by one.
 */
export function createFwiForecastService(options: FwiForecastServiceOptions): FwiForecastService {
  const ttlMs = options.ttlMs ?? DEFAULT_FWI_POINT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_FWI_POINT_MAX_ENTRIES;
  const budget = options.upstreamBudget ?? DEFAULT_FWI_POINT_UPSTREAM_BUDGET;
  const windowMs = options.upstreamWindowMs ?? DEFAULT_FWI_POINT_UPSTREAM_WINDOW_MS;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<FwiForecastLookup>>();
  let windowStart = Number.NEGATIVE_INFINITY;
  let spent = 0;

  return {
    lookup(point: SnappedPoint): Promise<FwiForecastLookup> {
      const key = `${String(point.latTenths)}/${String(point.lonTenths)}`;
      const now = options.clock.now();
      const today = effisUtcDate(now);
      const cached = cache.get(key);
      if (cached !== undefined) {
        const life = cached.lookup.ok ? ttlMs : Math.max(1, Math.floor(ttlMs / 10));
        if (cached.baseDate === today && now - cached.storedAt < life) {
          return Promise.resolve(cached.lookup);
        }
        cache.delete(key);
      }
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;

      if (now - windowStart >= windowMs) {
        windowStart = now;
        spent = 0;
      }
      if (spent >= budget) {
        return Promise.resolve({ ok: false, reason: 'budget_exhausted' });
      }
      spent += 1;

      const promise = lookupFwiForecast(options.client, options.clock, point)
        .then((lookup) => {
          if (cache.size >= maxEntries) cache.clear();
          cache.set(key, { storedAt: options.clock.now(), baseDate: today, lookup });
          return lookup;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, promise);
      return promise;
    },
  };
}
