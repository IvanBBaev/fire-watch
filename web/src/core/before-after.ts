/**
 * V2-E2 before/after comparison, the pure half: which two NASA GIBS daily mosaics to show
 * for an event, and which tiles of them cover the view around the event's centre.
 *
 * **Dates.** GIBS serves one true-colour mosaic per UTC day. "Before" is the day before
 * the first detection; "after" is the day after the last one. While an event is still
 * burning (or the day after its last detection has not been imaged and processed yet),
 * "after" is the latest day GIBS can have, labelled as such: never a day that has not
 * happened. The reader may step either date a day at a time within bounds, because the
 * one day the rule picks is often under cloud or smoke — nothing here knows whether it is,
 * and no label may claim the picture is clear.
 *
 * **Tiles.** Web Mercator (GIBS `epsg3857`), the `GoogleMapsCompatible_Level9` matrix set
 * of the VIIRS layer, 256 px tiles drawn at {@link TILE_SCALE}× so a 375 m pixel is a few
 * CSS pixels wide. Offsets are relative to the view's centre, so the caller can place a
 * tile with `left: calc(50% + <leftPx>px)` at any view size.
 *
 * DATA-SOURCES §B2; licence: `docs/licenses/nasa-gibs.md`.
 */

/** `YYYY-MM-DD`, a UTC calendar day — the WMTS `Time` dimension of a daily GIBS layer. */
export type UtcDay = string;

/** The VIIRS (Suomi NPP) corrected-reflectance true-colour layer: ~375 m, daily. */
export const GIBS_LAYER = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
export const GIBS_MATRIX_SET = 'GoogleMapsCompatible_Level9';
/** The layer's deepest level; deeper zoom is a CSS scale, not more detail. */
export const GIBS_ZOOM = 9;
export const GIBS_TILE_PX = 256;
/** Each tile is drawn at twice its size (512 CSS px). */
export const TILE_SCALE = 2;

/**
 * The UTC hour after which today's mosaic is taken to exist. Suomi NPP crosses the Balkans
 * around 11–12 UTC and GIBS publishes typically 4–5 h after the pass (DATA-SOURCES §B2), so
 * before this hour the latest day offered is yesterday. A day too early shows an empty or
 * partial mosaic; a day too late only delays the newest picture.
 */
export const GIBS_SAME_DAY_READY_UTC_HOUR = 18;

/** How far either date may be stepped away from the day the rule picks. */
export const MAX_SHIFT_DAYS = 30;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC day an instant (epoch ms) falls on. */
export function utcDayOf(ms: number): UtcDay {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `day` moved by `days` whole days. */
export function addDays(day: UtcDay, days: number): UtcDay {
  return utcDayOf(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);
}

/** The newest day whose mosaic GIBS can have published by `nowMs`. */
export function latestAvailableDay(nowMs: number): UtcDay {
  const today = utcDayOf(nowMs);
  return new Date(nowMs).getUTCHours() >= GIBS_SAME_DAY_READY_UTC_HOUR ? today : addDays(today, -1);
}

/** Inclusive bounds a date may be stepped within. */
export interface DayRange {
  readonly earliest: UtcDay;
  readonly latest: UtcDay;
}

/**
 * What the "after" image is, for the label:
 * - `after-last`: a day after the last detection (the rule's choice, or a later one);
 * - `latest`: the newest day available, which is not after the last detection — the fire
 *   may still have been detected on it.
 */
export type AfterKind = 'after-last' | 'latest';

export interface ComparisonDates {
  readonly before: UtcDay;
  readonly after: UtcDay;
  readonly afterKind: AfterKind;
  readonly beforeRange: DayRange;
  readonly afterRange: DayRange;
  /** The UTC day of the last detection, kept so a stepped `after` is labelled honestly. */
  readonly lastDetectionDay: UtcDay;
}

/**
 * The two days to compare for an event, or `null` when no pair exists: an unparseable
 * instant, or a newest available day that is not after the day before the first detection
 * (a fire first seen today before today's mosaic is out, or a clock behind the data).
 */
export function comparisonDates(
  firstObservedAt: string,
  lastObservedAt: string,
  nowMs: number,
): ComparisonDates | null {
  const firstMs = Date.parse(firstObservedAt);
  const lastMs = Date.parse(lastObservedAt);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || !Number.isFinite(nowMs)) {
    return null;
  }
  const firstDay = utcDayOf(Math.min(firstMs, lastMs));
  const lastDay = utcDayOf(Math.max(firstMs, lastMs));
  const latest = latestAvailableDay(nowMs);
  const before = addDays(firstDay, -1);
  if (latest <= before) return null;

  const dayAfterLast = addDays(lastDay, 1);
  const afterRange: DayRange =
    latest < dayAfterLast
      ? { earliest: latest, latest }
      : { earliest: dayAfterLast, latest: minDay(latest, addDays(dayAfterLast, MAX_SHIFT_DAYS)) };
  const beforeRange: DayRange = {
    earliest: addDays(before, -MAX_SHIFT_DAYS),
    // Never the first detection's own day, and always older than the earliest "after".
    latest: minDay(before, addDays(afterRange.earliest, -1)),
  };
  const after = afterRange.earliest;
  return {
    before: beforeRange.latest,
    after,
    afterKind: afterKindOf(after, lastDay),
    beforeRange,
    afterRange,
    lastDetectionDay: lastDay,
  };
}

/**
 * The comparison with one of its dates moved by `delta` days, or unchanged when that would
 * leave the date's range. The pair always stays in order (before < after).
 */
export function shiftDate(
  dates: ComparisonDates,
  which: 'before' | 'after',
  delta: number,
): ComparisonDates {
  if (which === 'before') {
    const before = addDays(dates.before, delta);
    if (!inRange(before, dates.beforeRange) || before >= dates.after) return dates;
    return { ...dates, before };
  }
  const after = addDays(dates.after, delta);
  if (!inRange(after, dates.afterRange) || after <= dates.before) return dates;
  return { ...dates, after, afterKind: afterKindOf(after, dates.lastDetectionDay) };
}

/** Whether `shiftDate(dates, which, delta)` would move anything — for disabling a button. */
export function canShift(
  dates: ComparisonDates,
  which: 'before' | 'after',
  delta: number,
): boolean {
  return shiftDate(dates, which, delta) !== dates;
}

function afterKindOf(after: UtcDay, lastDay: UtcDay): AfterKind {
  return after > lastDay ? 'after-last' : 'latest';
}

function inRange(day: UtcDay, range: DayRange): boolean {
  return DAY_RE.test(day) && day >= range.earliest && day <= range.latest;
}

function minDay(a: UtcDay, b: UtcDay): UtcDay {
  return a <= b ? a : b;
}

/* -------------------------------------------------------------------------- */
/* Tiles                                                                       */
/* -------------------------------------------------------------------------- */

export interface ComparisonTile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  /** CSS px from the view's centre to the tile's left edge (already scaled). */
  readonly leftPx: number;
  /** CSS px from the view's centre to the tile's top edge (already scaled). */
  readonly topPx: number;
}

/** The tile edge in CSS px. */
export const TILE_CSS_PX = GIBS_TILE_PX * TILE_SCALE;

/**
 * The tiles covering a view of `halfWidthPx` × `halfHeightPx` (CSS px either side of the
 * centre) around `lon`/`lat`, at {@link GIBS_ZOOM}. Columns wrap at the antimeridian; rows
 * outside the matrix are dropped.
 */
export function comparisonTiles(
  lon: number,
  lat: number,
  halfWidthPx: number,
  halfHeightPx: number,
): readonly ComparisonTile[] {
  const z = GIBS_ZOOM;
  const count = 2 ** z;
  const world = GIBS_TILE_PX * count;
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  const cx = ((lon + 180) / 360) * world;
  const cy = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world;
  const halfW = halfWidthPx / TILE_SCALE;
  const halfH = halfHeightPx / TILE_SCALE;
  const tiles: ComparisonTile[] = [];
  const firstRow = Math.floor((cy - halfH) / GIBS_TILE_PX);
  const lastRow = Math.floor((cy + halfH) / GIBS_TILE_PX);
  const firstCol = Math.floor((cx - halfW) / GIBS_TILE_PX);
  const lastCol = Math.floor((cx + halfW) / GIBS_TILE_PX);
  for (let row = firstRow; row <= lastRow; row += 1) {
    if (row < 0 || row >= count) continue;
    for (let col = firstCol; col <= lastCol; col += 1) {
      tiles.push({
        z,
        x: ((col % count) + count) % count,
        y: row,
        leftPx: Math.round((col * GIBS_TILE_PX - cx) * TILE_SCALE),
        topPx: Math.round((row * GIBS_TILE_PX - cy) * TILE_SCALE),
      });
    }
  }
  return tiles;
}

/** The GIBS WMTS REST URL of one tile of the true-colour mosaic of `day`. */
export function gibsTileUrl(day: UtcDay, tile: Pick<ComparisonTile, 'z' | 'x' | 'y'>): string {
  return (
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_LAYER}/default/${day}/` +
    `${GIBS_MATRIX_SET}/${String(tile.z)}/${String(tile.y)}/${String(tile.x)}.jpg`
  );
}
