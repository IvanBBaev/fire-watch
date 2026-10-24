/**
 * V2-A1 playback, the pure half the first render needs: the ranges, the shape of what
 * `GET /api/v1/history?range=…` (or the committed fixture) answers, the cursor's instants
 * and how the `pb=` fragment member spells them. Checking a body, stepping and playing,
 * and how a replay is drawn (the age classes and the FRP ladder described below) live in
 * `core/history-body.ts`, which only the lazy replay chunks import (CI-12).
 *
 * ## What is replayed
 *
 * The body is the server's columnar frame of the archived satellite hotspot detections in
 * one aligned window (`server/src/core/history/history-frame.ts`). They are heat seen from
 * orbit, not confirmed fires, and nothing here predicts anything: the cursor only ever
 * reveals what was already detected by that instant.
 *
 * ## Time
 *
 * Every instant comes from the body. A detection's `t` is whole minutes from
 * `window_from`; the cursor is in the same unit, from `0` to the window's length, and a
 * detection is drawn when `t <= cursor`. Its age at the cursor (`cursor - t`) picks its
 * class. The newest class is the confirmed-fire red, then the detection orange, then the
 * likely orange, then the no-longer-detected gray — exactly the fire registry's own
 * colours (CI-14: fire owns red, and this layer is fire-owned), so a replay never invents
 * a colour the live map does not use.
 *
 * ## Size
 *
 * Fire radiative power, when the product has it, grows the dot along a fixed ladder; a
 * detection without FRP is the smallest. Size is a second channel beside colour, so the
 * age classes do not rest on hue alone.
 */

/** The ranges a reader can ask for, shortest first; the server's list, mirrored. */
export const HISTORY_RANGES = ['24h', '3d', '7d'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

const MINUTE_MS = 60_000;

/** Each range's length in minutes — the cursor's upper bound. */
export const HISTORY_RANGE_MINUTES: Readonly<Record<HistoryRange, number>> = {
  '24h': 24 * 60,
  '3d': 72 * 60,
  '7d': 168 * 60,
};

/**
 * A play speed. The speeds and the tick, the step grid, the age classes and the FRP ladder
 * live with the replay (`core/history-body.ts`).
 */
export type PlaybackSpeed = 1 | 2 | 4;

/* ----------------------------------------------------------------------------------- */
/* The wire document                                                                    */
/* ----------------------------------------------------------------------------------- */

export interface HistoryAttribution {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly href?: string;
}

export interface HistoryColumns {
  readonly t: readonly number[];
  readonly lon: readonly number[];
  readonly lat: readonly number[];
  readonly frp: readonly (number | null)[];
  readonly s: readonly number[];
  readonly e: readonly number[];
}

/** The wire shape, as the route and the fixtures spell it. */
export interface HistoryBody {
  readonly schema_version: 1;
  readonly range: HistoryRange;
  readonly window_from: string;
  readonly window_to: string;
  readonly generated_at: string;
  readonly truncated: boolean;
  readonly count: number;
  readonly sources: readonly string[];
  readonly events: readonly string[];
  readonly detections: HistoryColumns;
  readonly attribution: readonly HistoryAttribution[];
}

/* ----------------------------------------------------------------------------------- */
/* The cursor                                                                           */
/* ----------------------------------------------------------------------------------- */

/** Clamp a cursor into `[0, rangeMinutes]`, whole minutes. */
export function clampCursor(cursor: number, range: HistoryRange): number {
  if (!Number.isFinite(cursor)) return HISTORY_RANGE_MINUTES[range];
  return Math.min(HISTORY_RANGE_MINUTES[range], Math.max(0, Math.round(cursor)));
}

/** The instant a cursor names, as epoch ms. */
export function cursorInstantMs(body: Pick<HistoryBody, 'window_from'>, cursor: number): number {
  return Date.parse(body.window_from) + cursor * MINUTE_MS;
}

/** The cursor for an instant, clamped into the body's window. */
export function cursorForInstant(
  body: Pick<HistoryBody, 'window_from' | 'range'>,
  atMs: number,
): number {
  return clampCursor(Math.floor((atMs - Date.parse(body.window_from)) / MINUTE_MS), body.range);
}

/* ----------------------------------------------------------------------------------- */
/* The `pb=` fragment member                                                            */
/* ----------------------------------------------------------------------------------- */

export const PLAYBACK_HASH_KEY = 'pb';

/** What `pb=` says: the range, and the paused cursor's instant when one is pinned. */
export interface PlaybackLink {
  readonly range: HistoryRange;
  /** Epoch ms, whole minutes UTC; `null` = the window's end. */
  readonly atMs: number | null;
}

const PB_PATTERN = /^(24h|3d|7d)(?:@(\d{4})(\d{2})(\d{2})(\d{2})(\d{2}))?$/u;

/**
 * `24h`, or `3d@202608091030` (UTC); `null` for anything else. A date or time that does
 * not exist (`20260231…`, hour 24) is refused rather than rolled over: the parsed instant
 * must spell the member back exactly.
 */
export function parsePlaybackParam(raw: string | null): PlaybackLink | null {
  const match = raw === null ? null : PB_PATTERN.exec(raw);
  if (match === null) return null;
  const range = match[1] as HistoryRange;
  if (match[2] === undefined) return { range, atMs: null };
  const [year, month, day, hour, minute] = match.slice(2, 7).map(Number);
  const link = { range, atMs: Date.UTC(year!, month! - 1, day, hour, minute) };
  return formatPlaybackParam(link) === raw ? link : null;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** The member's value for a range and an optional pinned instant. */
export function formatPlaybackParam(link: PlaybackLink): string {
  if (link.atMs === null) return link.range;
  const at = new Date(Math.floor(link.atMs / MINUTE_MS) * MINUTE_MS);
  return (
    `${link.range}@${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}` +
    `${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`
  );
}

/* ----------------------------------------------------------------------------------- */
/* What the map takes                                                                   */
/* ----------------------------------------------------------------------------------- */

export interface PlaybackFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  /** `t` minutes from the window start; `frp` MW or `null`; `e` event index or `-1`. */
  readonly properties: { readonly t: number; readonly frp: number | null; readonly e: number };
}

export interface PlaybackCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly PlaybackFeature[];
}

/**
 * What the map controller takes. `collection` keeps its identity for one body, so the
 * layer re-adds its source only when the body changes; a cursor move is a filter and
 * paint update.
 */
export interface PlaybackDraw {
  readonly collection: PlaybackCollection;
  /** The FIRMS credit, rendered from the contracts registry. */
  readonly attribution: string;
  /** Minutes from the window start; detections with `t <= cursor` are drawn. */
  readonly cursor: number;
}
