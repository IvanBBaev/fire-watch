/**
 * The coarse, privacy-safe grid pass predictions are served on (TASKS F15).
 *
 * The reader never sends a location: the web asks for the cell under the map centre or
 * the selected event, and that cell is a 0.5° square (~55 × 40 km at Bulgaria's latitude).
 * A request therefore says no more about a reader than which part of the region their map
 * is showing, and every reader of one cell shares one cacheable document.
 *
 * Pass times move by seconds across a cell, and the cross-track distance by at most the
 * cell's half-diagonal (~35 km) — against a swath edge 700–1 500 km from the track, a
 * cell-centre answer is the right answer for every point in the cell except a thin band at
 * the swath edge, which the web labels as "near the edge" by showing the distance.
 *
 * Only cells whose centre lies inside `polling_bbox_v1` are served: the product watches
 * that box and a pass elsewhere is a look at nothing it reports.
 */

import { POLLING_BBOX } from '../config/polling-bbox.js';
import type { EpochMs } from '../ports/clock.js';
import type { GroundPoint } from './pass-compute.js';

export const PASS_CELL_DEG = 0.5;

/** How far back and forward a document looks, relative to its time bucket. */
export const PASS_LOOKBACK_MS = 12 * 3_600_000;
export const PASS_LOOKAHEAD_MS = 24 * 3_600_000;
/**
 * Documents are computed for a 10-minute bucket, so every reader in the same ten minutes
 * shares one ETag and one computation, and the window slides forward in visible steps.
 */
export const PASS_BUCKET_MS = 10 * 60_000;

export interface PassCell {
  /** `42.75_25.25` — the centre, two decimals, latitude first. */
  readonly id: string;
  readonly centre: GroundPoint;
}

const CELL_ID_RE = /^(-?\d{1,2}\.\d{2})_(-?\d{1,3}\.\d{2})$/;

function centreOf(value: number): number {
  return Math.floor(value / PASS_CELL_DEG) * PASS_CELL_DEG + PASS_CELL_DEG / 2;
}

function formatCoordinate(value: number): string {
  // `-0.00` cannot occur: a cell centre is always an odd multiple of 0.25.
  return value.toFixed(2);
}

function insideBox(point: GroundPoint): boolean {
  const box = POLLING_BBOX.values;
  return (
    point.lat > box.south && point.lat < box.north && point.lon > box.west && point.lon < box.east
  );
}

/** The cell containing a point, or null when that cell is outside the served box. */
export function cellFor(point: GroundPoint): PassCell | null {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  const centre = { lat: centreOf(point.lat), lon: centreOf(point.lon) };
  if (!insideBox(centre)) return null;
  return { id: `${formatCoordinate(centre.lat)}_${formatCoordinate(centre.lon)}`, centre };
}

/**
 * A cell id from a URL, accepted only in its canonical spelling: `42.75_25.25`, never
 * `42.7_25.3` or `42.750_25.25`. One cell, one URL — otherwise a CDN caches the same
 * document under many keys, and an id that is not a centre would be a precise point
 * smuggled through the coarse grid.
 */
export function parseCellId(id: string): PassCell | null {
  const match = CELL_ID_RE.exec(id);
  if (match === null) return null;
  const cell = cellFor({ lat: Number(match[1]), lon: Number(match[2]) });
  return cell !== null && cell.id === id ? cell : null;
}

export function passBucketStart(nowMs: EpochMs): EpochMs {
  return Math.floor(nowMs / PASS_BUCKET_MS) * PASS_BUCKET_MS;
}

export function passWindowFor(bucketMs: EpochMs): { fromMs: EpochMs; toMs: EpochMs } {
  return { fromMs: bucketMs - PASS_LOOKBACK_MS, toMs: bucketMs + PASS_LOOKAHEAD_MS };
}
