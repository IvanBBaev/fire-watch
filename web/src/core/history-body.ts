/**
 * V2-A1 playback, the half only a running replay needs: checking a history body (and its
 * range), turning it into the map's GeoJSON, counting what is on screen at a cursor, the
 * play speeds, the step grid, and the age classes and FRP ladder the replayed dots are drawn with.
 *
 * Kept apart from `core/playback.ts` because that module is on the first-render path (the
 * `pb=` fragment member and the cursor's instants) while this one is imported only by the
 * lazy replay module (`ui/playback-replay.tsx`) and the lazily loaded map layer
 * (`map/playback-layer.ts`), so none of it is charged to the entry or the map (CI-12).
 */

import {
  HISTORY_RANGES,
  HISTORY_RANGE_MINUTES,
  clampCursor,
  type HistoryRange,
  type HistoryAttribution,
  type HistoryBody,
  type HistoryColumns,
  type PlaybackCollection,
  type PlaybackFeature,
  type PlaybackSpeed,
} from './playback.js';

const MINUTE_MS = 60_000;

/** Whether a wire value is one of the ranges this build can replay. */
export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === 'string' && (HISTORY_RANGES as readonly string[]).includes(value);
}

/* ----------------------------------------------------------------------------------- */
/* Speed                                                                                */
/* ----------------------------------------------------------------------------------- */

/** Play speeds, cycled by the speed button. */
export const PLAYBACK_SPEEDS: readonly PlaybackSpeed[] = [1, 2, 4];

/** One tick at 1× speed; faster speeds divide it. */
export const PLAYBACK_TICK_MS = 500;

export function playbackTickMs(speed: PlaybackSpeed): number {
  return PLAYBACK_TICK_MS / speed;
}

export function nextSpeed(speed: PlaybackSpeed): PlaybackSpeed {
  const index = PLAYBACK_SPEEDS.indexOf(speed);
  return PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length] ?? 1;
}

/* ----------------------------------------------------------------------------------- */
/* Steps, age classes and size                                                          */
/* ----------------------------------------------------------------------------------- */

/** One step of the scrubber, and one tick of play, per range. */
export const PLAYBACK_STEP_MINUTES: Readonly<Record<HistoryRange, number>> = {
  '24h': 15,
  '3d': 30,
  '7d': 60,
};

/** One step back (`-1`) or forward (`1`), snapped to the step grid and clamped. */
export function stepCursor(cursor: number, direction: -1 | 1, range: HistoryRange): number {
  const step = PLAYBACK_STEP_MINUTES[range];
  const snapped =
    direction > 0
      ? Math.floor(cursor / step) * step + step
      : Math.ceil(cursor / step) * step - step;
  return clampCursor(snapped, range);
}

/**
 * Age classes at the cursor, newest first. `upperMinutes` is the exclusive ceiling; the
 * last class has none. The colours are the fire registry's (`map/layer-registry.ts`:
 * confirmed, detection, likely, no longer detected) — a test pins the equality.
 */
export const PLAYBACK_AGE_CLASSES = [
  { upperMinutes: 60, color: '#d7301f', opacity: 0.95 },
  { upperMinutes: 6 * 60, color: '#e8590c', opacity: 0.85 },
  { upperMinutes: 24 * 60, color: '#f16913', opacity: 0.7 },
  { upperMinutes: null, color: '#8b9198', opacity: 0.55 },
] as const;

export type PlaybackAgeClass = 0 | 1 | 2 | 3;

/** The class of a detection `ageMinutes` old at the cursor. */
export function playbackAgeClass(ageMinutes: number): PlaybackAgeClass {
  for (let index = 0; index < PLAYBACK_AGE_CLASSES.length; index += 1) {
    const upper = PLAYBACK_AGE_CLASSES[index]?.upperMinutes;
    if (upper === null || upper === undefined || ageMinutes < upper) {
      return index as PlaybackAgeClass;
    }
  }
  return 3;
}

/** FRP (MW) → circle radius (px at zoom 7): the size ladder the layer interpolates. */
export const PLAYBACK_FRP_RADIUS = [
  [0, 3],
  [10, 4],
  [100, 7],
  [1000, 10],
] as const;

/* ----------------------------------------------------------------------------------- */
/* The wire document                                                                    */
/* ----------------------------------------------------------------------------------- */

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/u;

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isAttribution(value: unknown): value is HistoryAttribution {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['source'] === 'string' &&
    typeof entry['text'] === 'string' &&
    (entry['href'] === undefined || typeof entry['href'] === 'string')
  );
}

function columnsValid(
  value: unknown,
  rangeMinutes: number,
  sources: number,
  events: number,
): value is HistoryColumns {
  if (typeof value !== 'object' || value === null) return false;
  const columns = value as Record<string, unknown>;
  const { t, lon, lat, frp, s, e } = columns;
  if (![t, lon, lat, frp, s, e].every(Array.isArray)) return false;
  const tt = t as unknown[];
  const n = tt.length;
  if (![lon, lat, frp, s, e].every((column) => (column as unknown[]).length === n)) return false;
  for (let i = 0; i < n; i += 1) {
    const minute = tt[i];
    const x = (lon as unknown[])[i];
    const y = (lat as unknown[])[i];
    const power = (frp as unknown[])[i];
    const source = (s as unknown[])[i];
    const event = (e as unknown[])[i];
    if (!isFiniteNumber(minute) || !Number.isInteger(minute)) return false;
    if (minute < 0 || minute >= rangeMinutes) return false;
    if (i > 0 && minute < (tt[i - 1] as number)) return false;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || Math.abs(x) > 180 || Math.abs(y) > 90) {
      return false;
    }
    if (power !== null && (!isFiniteNumber(power) || power < 0)) return false;
    if (!Number.isInteger(source) || (source as number) < 0 || (source as number) >= sources) {
      return false;
    }
    if (!Number.isInteger(event) || (event as number) < -1 || (event as number) >= events) {
      return false;
    }
  }
  return true;
}

/**
 * The body, or `null` when it is not one this build can replay honestly: wrong schema,
 * an unknown range, a window whose length is not the range's, unreadable times, columns of
 * different lengths, out-of-window or unsorted minutes, or a bad index. Never throws.
 */
export function parseHistoryBody(value: unknown): HistoryBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body['schema_version'] !== 1) return null;
  const range = body['range'];
  if (!isHistoryRange(range)) return null;
  const from = body['window_from'];
  const to = body['window_to'];
  if (!isInstant(from) || !isInstant(to) || !isInstant(body['generated_at'])) return null;
  const rangeMinutes = HISTORY_RANGE_MINUTES[range];
  if (Date.parse(to) - Date.parse(from) !== rangeMinutes * MINUTE_MS) return null;
  if (typeof body['truncated'] !== 'boolean') return null;
  const sources = body['sources'];
  const events = body['events'];
  if (!isStringArray(sources) || !isStringArray(events)) return null;
  const attribution = body['attribution'];
  if (!Array.isArray(attribution) || !attribution.every(isAttribution)) return null;
  if (!columnsValid(body['detections'], rangeMinutes, sources.length, events.length)) return null;
  const count = body['count'];
  if (count !== body['detections'].t.length) return null;
  return value as HistoryBody;
}

/* ----------------------------------------------------------------------------------- */
/* What the cursor shows                                                                */
/* ----------------------------------------------------------------------------------- */

/** How many detections are on screen at `cursor` (`t <= cursor`; `t` is ascending). */
export function shownCount(body: Pick<HistoryBody, 'detections'>, cursor: number): number {
  const t = body.detections.t;
  let low = 0;
  let high = t.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((t[middle] ?? 0) <= cursor) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The body as GeoJSON, oldest first so the newest detections paint on top. Pure. */
export function playbackCollection(body: HistoryBody): PlaybackCollection {
  const { t, lon, lat, frp, e } = body.detections;
  const features: PlaybackFeature[] = [];
  for (let i = 0; i < t.length; i += 1) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon[i] ?? 0, lat[i] ?? 0] },
      properties: { t: t[i] ?? 0, frp: frp[i] ?? null, e: e[i] ?? -1 },
    });
  }
  return { type: 'FeatureCollection', features };
}
