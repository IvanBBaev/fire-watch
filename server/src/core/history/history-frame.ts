/**
 * V2-A1 playback, the pure half of `GET /api/v1/history`: which window a request names,
 * and how the stored detections in it become the compact, columnar document the web
 * scrubber replays.
 *
 * ## Fixed ranges, aligned windows
 *
 * A request names one of {@link HISTORY_RANGES}, never a free start and end. The window
 * ends at the last {@link HISTORY_BUCKET_MS} boundary at or before "now" and reaches back
 * the range's length, so every reader within the same ten minutes asks the same question
 * and the edge can answer all but the first. The newest few minutes are therefore not in
 * the playback; the live map shows them.
 *
 * ## A bounded, deterministic body
 *
 * The document is a function of the window and the rows only — `generated_at` is the
 * window's end, not the request instant — so its hash is a content address and two origins
 * answering the same window produce the same bytes and the same ETag.
 *
 * Detections travel as parallel arrays rather than GeoJSON features: a week of a bad
 * season is thousands of points, and the per-feature keys would be most of the bytes.
 * Coordinates are quantised to {@link COORDINATE_DECIMALS} decimals (about 110 m, well
 * inside a 375 m VIIRS pixel), times to whole minutes from the window start (the archive
 * stores minutes anyway), FRP to one decimal. At most `maxDetections` rows are carried —
 * the newest — and `truncated` says when older ones were left out.
 *
 * ## What the rows are
 *
 * Satellite hotspot detections, as archived: not confirmed fires, and nothing here
 * predicts anything. The event index only says which live event the clustering attached a
 * detection to, so a replay can show an event growing; it is `-1` for a detection no live
 * event holds.
 */

import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { HistoryDetectionRow } from '../ports/history-reader.js';

/** The ranges a reader can ask for, shortest first. Order is the UI's order too. */
export const HISTORY_RANGES = ['24h', '3d', '7d'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const HISTORY_RANGE_MS: Readonly<Record<HistoryRange, number>> = {
  '24h': 24 * HOUR_MS,
  '3d': 72 * HOUR_MS,
  '7d': 168 * HOUR_MS,
};

/** The window end's alignment; also how long one window stays the current one. */
export const HISTORY_BUCKET_MS = 10 * MINUTE_MS;

/** About 110 m at the equator, less in longitude at Bulgaria's latitude. */
export const COORDINATE_DECIMALS = 3;

/** Bumped when the document's shape changes incompatibly; part of the ETag. */
export const HISTORY_SCHEMA_VERSION = 1;

/**
 * The default body bound: about 30 bytes a row, so a full body stays near 300 KB before
 * compression. A week in Bulgaria is far below this outside an exceptional season.
 */
export const DEFAULT_MAX_HISTORY_DETECTIONS = 10_000;

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === 'string' && (HISTORY_RANGES as readonly string[]).includes(value);
}

export interface HistoryWindow {
  readonly range: HistoryRange;
  /** Inclusive. */
  readonly fromMs: EpochMs;
  /** Exclusive. */
  readonly toMs: EpochMs;
}

/** The window `range` names at `nowMs`: aligned down to the bucket, half-open. */
export function historyWindow(range: HistoryRange, nowMs: EpochMs): HistoryWindow {
  if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite');
  const toMs = Math.floor(nowMs / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
  return { range, fromMs: toMs - HISTORY_RANGE_MS[range], toMs };
}

export type HistoryQueryVerdict =
  | { readonly ok: true; readonly range: HistoryRange }
  | { readonly ok: false; readonly reason: 'unknown_parameter' | 'bad_range' };

/**
 * The query string, checked: exactly one parameter, `range`, holding a known range.
 * Anything else is refused, so a cache-buster cannot turn one cacheable URL into an
 * origin hit per request. A repeated `range` arrives as an array and is refused too.
 */
export function parseHistoryQuery(query: unknown): HistoryQueryVerdict {
  const entries: [string, unknown][] =
    typeof query === 'object' && query !== null ? Object.entries(query) : [];
  for (const [key] of entries) {
    if (key !== 'range') return { ok: false, reason: 'unknown_parameter' };
  }
  const range: unknown = entries.find(([key]) => key === 'range')?.[1];
  return isHistoryRange(range) ? { ok: true, range } : { ok: false, reason: 'bad_range' };
}

export interface HistoryAttribution {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly href?: string;
}

/** The columnar detections: index `i` across every array is one detection. */
export interface HistoryColumns {
  /** Minutes from `window_from`, ascending. */
  readonly t: readonly number[];
  readonly lon: readonly number[];
  readonly lat: readonly number[];
  /** Fire radiative power in MW to one decimal, `null` where the product has none. */
  readonly frp: readonly (number | null)[];
  /** Index into `sources`. */
  readonly s: readonly number[];
  /** Index into `events`, or `-1` when no live event holds the detection. */
  readonly e: readonly number[];
}

export interface HistoryDocument {
  readonly schema_version: number;
  readonly range: HistoryRange;
  readonly window_from: string;
  readonly window_to: string;
  /** The window's end: the body depends on nothing later. */
  readonly generated_at: string;
  /** True when older detections were left out to keep the body bounded. */
  readonly truncated: boolean;
  readonly count: number;
  /** Registry source ids, sorted. */
  readonly sources: readonly string[];
  /** Live event public ids, sorted. */
  readonly events: readonly string[];
  readonly detections: HistoryColumns;
  readonly attribution: readonly HistoryAttribution[];
}

export function quantiseCoordinate(value: number): number {
  const scale = 10 ** COORDINATE_DECIMALS;
  // `+ 0` folds a negative zero, which JSON would otherwise print as `0` anyway.
  return Math.round(value * scale) / scale + 0;
}

function quantiseFrp(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * The document for `window` from `rows`. `rows` may arrive in any order and may hold one
 * row more than `maxDetections` (the reader's probe row); the newest `maxDetections` in
 * the window are kept. Rows outside the window are dropped, not trusted. Pure.
 */
export function buildHistoryDocument(input: {
  readonly window: HistoryWindow;
  readonly rows: readonly HistoryDetectionRow[];
  readonly maxDetections: number;
  readonly attribution: readonly HistoryAttribution[];
}): HistoryDocument {
  const { window, maxDetections } = input;
  if (!Number.isSafeInteger(maxDetections) || maxDetections < 1) {
    throw new RangeError('maxDetections must be a positive safe integer');
  }
  const inWindow = input.rows
    .filter((row) => row.observedAt >= window.fromMs && row.observedAt < window.toMs)
    .slice()
    .sort((a, b) => a.observedAt - b.observedAt || compare(a.uid, b.uid));
  const truncated = inWindow.length > maxDetections;
  const kept = truncated ? inWindow.slice(inWindow.length - maxDetections) : inWindow;

  const sources = sortedUnique(kept.map((row) => row.sourceId));
  const events = sortedUnique(
    kept.flatMap((row) => (row.eventPublicId === null ? [] : [row.eventPublicId])),
  );
  const sourceIndex = new Map(sources.map((id, index) => [id, index]));
  const eventIndex = new Map(events.map((id, index) => [id, index]));

  const t: number[] = [];
  const lon: number[] = [];
  const lat: number[] = [];
  const frp: (number | null)[] = [];
  const s: number[] = [];
  const e: number[] = [];
  for (const row of kept) {
    t.push(Math.floor((row.observedAt - window.fromMs) / MINUTE_MS));
    lon.push(quantiseCoordinate(row.lon));
    lat.push(quantiseCoordinate(row.lat));
    frp.push(quantiseFrp(row.frpMw));
    s.push(sourceIndex.get(row.sourceId) ?? 0);
    e.push(row.eventPublicId === null ? -1 : (eventIndex.get(row.eventPublicId) ?? -1));
  }

  return {
    schema_version: HISTORY_SCHEMA_VERSION,
    range: window.range,
    window_from: isoFromEpochMs(window.fromMs),
    window_to: isoFromEpochMs(window.toMs),
    generated_at: isoFromEpochMs(window.toMs),
    truncated,
    count: kept.length,
    sources,
    events,
    detections: { t, lon, lat, frp, s, e },
    attribution: input.attribution,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
