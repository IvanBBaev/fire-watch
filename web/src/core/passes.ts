/**
 * The F15 satellite-pass document, the pure half: what the server's (or the fixture's)
 * `/api/v1/passes/<cell>` body is, how it is validated, which cell a map point asks for,
 * and which pass is "the last look" and which "the next".
 *
 * The browser never computes an orbit: SGP4 (`satellite.js`) runs on the server, and this
 * module only reads the times it produced. It never sends a location either — the request
 * names a 0.5° grid cell, the same rule the server's `pass-grid.ts` applies, so a reader's
 * map centre or selected fire is coarsened before it leaves the page.
 *
 * Everything in the document is a **prediction** (`predicted: true`); the panel says so
 * next to every time it shows.
 */

import { POLLING_AREA } from './geo/coverage.js';
import { isInvalid, parsePassCloudPct, parsePassesCloud, type PassesCloud } from './pass-cloud.js';

export type PassPlatformId = 'snpp' | 'noaa20' | 'noaa21' | 's3a' | 's3b';

export type PassDaylight = 'day' | 'night';

export type ElementsState = 'current' | 'stale' | 'missing';

export interface PassEntry {
  readonly aos: string;
  readonly culmination: string;
  readonly los: string;
  readonly max_elevation_deg: number;
  readonly cross_track_km: number;
  readonly in_swath: boolean;
  readonly daylight: PassDaylight;
  /** F17: forecast total cloud cover at the culmination, whole %; `null` = no forecast. */
  readonly cloud_forecast_pct: number | null;
}

export interface PlatformPasses {
  readonly id: PassPlatformId;
  readonly source: string;
  readonly instrument: 'viirs' | 'slstr';
  readonly swath_km: number;
  readonly elements: ElementsState;
  readonly elements_epoch: string | null;
  readonly elements_age_hours: number | null;
  readonly passes: readonly PassEntry[];
}

/** The wire shape, as the route and the fixture spell it. */
export interface PassesDoc {
  readonly schema_version: 1;
  readonly cell: string;
  readonly point: { readonly lat: number; readonly lon: number };
  readonly computed_for: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly predicted: true;
  readonly elements_provider: 'celestrak';
  /** F17: what `cloud_forecast_pct` is; `null` when the server stored no cloud forecast. */
  readonly cloud: PassesCloud | null;
  readonly platforms: readonly PlatformPasses[];
}

/** The server's grid step (`server/src/core/passes/pass-grid.ts`). */
export const PASS_CELL_DEG = 0.5;

/**
 * Platform and instrument names are proper nouns, not catalog copy: they read the same in
 * every language, like "VIIRS" in the source badges.
 */
export const PASS_PLATFORM_LABELS: Readonly<Record<PassPlatformId, string>> = {
  noaa20: 'NOAA-20 · VIIRS',
  snpp: 'Suomi NPP · VIIRS',
  noaa21: 'NOAA-21 · VIIRS',
  s3a: 'Sentinel-3A · SLSTR',
  s3b: 'Sentinel-3B · SLSTR',
};

const PLATFORM_IDS = new Set<string>(Object.keys(PASS_PLATFORM_LABELS));

// ── The cell ────────────────────────────────────────────────────────────────

function centreOf(value: number): number {
  return Math.floor(value / PASS_CELL_DEG) * PASS_CELL_DEG + PASS_CELL_DEG / 2;
}

/**
 * The cell id a point asks for, or `null` when that cell's centre is outside the polled
 * box (the server serves nothing there). Mirrors `cellFor` on the server byte for byte.
 */
export function passCellFor(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const centreLat = centreOf(lat);
  const centreLon = centreOf(lon);
  const box = POLLING_AREA;
  if (!(
    centreLat > box.south &&
    centreLat < box.north &&
    centreLon > box.west &&
    centreLon < box.east
  )) {
    return null;
  }
  return `${centreLat.toFixed(2)}_${centreLon.toFixed(2)}`;
}

/** The template with its `{cell}` filled; a template without one is a single fixture file. */
export function passesUrl(template: string, cell: string): string {
  return template.replace('{cell}', encodeURIComponent(cell));
}

// ── Validation ──────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
  Number.isFinite(Date.parse(value));

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function parsePass(value: unknown): PassEntry | null {
  if (!isRecord(value)) return null;
  const { aos, culmination, los, max_elevation_deg, cross_track_km, in_swath, daylight } = value;
  if (!isInstant(aos) || !isInstant(culmination) || !isInstant(los)) return null;
  if (!isFiniteNumber(max_elevation_deg) || !isFiniteNumber(cross_track_km)) return null;
  if (typeof in_swath !== 'boolean' || (daylight !== 'day' && daylight !== 'night')) return null;
  const cloud_forecast_pct = parsePassCloudPct(value['cloud_forecast_pct']);
  if (isInvalid(cloud_forecast_pct)) return null;
  return {
    aos,
    culmination,
    los,
    max_elevation_deg,
    cross_track_km,
    in_swath,
    daylight,
    cloud_forecast_pct,
  };
}

function parsePlatform(value: unknown): PlatformPasses | null {
  if (!isRecord(value)) return null;
  const { id, source, instrument, swath_km, elements, elements_epoch, elements_age_hours } = value;
  if (typeof id !== 'string' || !PLATFORM_IDS.has(id)) return null;
  if (typeof source !== 'string' || (instrument !== 'viirs' && instrument !== 'slstr')) return null;
  if (!isFiniteNumber(swath_km)) return null;
  if (elements !== 'current' && elements !== 'stale' && elements !== 'missing') return null;
  if (elements_epoch !== null && !isInstant(elements_epoch)) return null;
  if (elements_age_hours !== null && !isFiniteNumber(elements_age_hours)) return null;
  if (!Array.isArray(value['passes'])) return null;
  const passes: PassEntry[] = [];
  for (const raw of value['passes'] as unknown[]) {
    const pass = parsePass(raw);
    if (pass === null) return null;
    passes.push(pass);
  }
  return {
    id: id as PassPlatformId,
    source,
    instrument,
    swath_km,
    elements,
    elements_epoch,
    elements_age_hours,
    passes,
  };
}

/**
 * A body → the document, or `null` for anything that is not exactly schema 1. Strict on
 * purpose: a half-understood prediction would be shown as a fact about the sky.
 */
export function parsePassesDocument(value: unknown): PassesDoc | null {
  if (!isRecord(value)) return null;
  if (value['schema_version'] !== 1 || value['predicted'] !== true) return null;
  if (value['elements_provider'] !== 'celestrak') return null;
  const { cell, point, computed_for, window } = value;
  if (typeof cell !== 'string' || !isInstant(computed_for)) return null;
  if (!isRecord(point) || !isFiniteNumber(point['lat']) || !isFiniteNumber(point['lon'])) {
    return null;
  }
  if (!isRecord(window) || !isInstant(window['from']) || !isInstant(window['to'])) return null;
  if (!Array.isArray(value['platforms'])) return null;
  const platforms: PlatformPasses[] = [];
  for (const raw of value['platforms'] as unknown[]) {
    const platform = parsePlatform(raw);
    if (platform === null) return null;
    platforms.push(platform);
  }
  const cloud = parsePassesCloud(value['cloud']);
  if (isInvalid(cloud)) return null;
  // A value with nothing saying it is a forecast would be read as an observation.
  if (
    cloud === null &&
    platforms.some((p) => p.passes.some((x) => x.cloud_forecast_pct !== null))
  ) {
    return null;
  }
  return {
    schema_version: 1,
    cell,
    point: { lat: point['lat'], lon: point['lon'] },
    computed_for,
    window: { from: window['from'], to: window['to'] },
    predicted: true,
    elements_provider: 'celestrak',
    cloud,
    platforms,
  };
}

// ── Last and next ───────────────────────────────────────────────────────────

export interface LastAndNext {
  readonly last: PassEntry | null;
  readonly next: PassEntry | null;
}

/**
 * The latest in-swath pass whose culmination is at or before `nowMs`, and the earliest one
 * after it. A pass outside the swath is not a look — the instrument could not see the cell —
 * so it is never offered as one.
 */
export function lastAndNext(platform: PlatformPasses, nowMs: number): LastAndNext {
  let last: PassEntry | null = null;
  let lastMs = -Infinity;
  let next: PassEntry | null = null;
  let nextMs = Infinity;
  for (const pass of platform.passes) {
    if (!pass.in_swath) continue;
    const ms = Date.parse(pass.culmination);
    if (ms <= nowMs && ms > lastMs) {
      last = pass;
      lastMs = ms;
    } else if (ms > nowMs && ms < nextMs) {
      next = pass;
      nextMs = ms;
    }
  }
  return { last, next };
}

/**
 * Whether the document's forward window has run past `nowMs`: its "next" answers are then
 * incomplete (a later pass exists that it never computed), so the panel says so rather than
 * showing "none".
 */
export function passesWindowEnded(doc: PassesDoc, nowMs: number): boolean {
  return Date.parse(doc.window.to) <= nowMs;
}
