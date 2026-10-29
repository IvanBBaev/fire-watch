/**
 * The estimated outline of one event over time (V3-P3): the series V3-B1 (observed growth
 * direction), V3-B2 (area over time) and later V3-E1 read, and the only place it is built.
 *
 * **What a point is.** Migration 032 keeps one outline per event — the latest — so the
 * history is not stored, it is replayed. Each point is {@link drawFireOutline} over every
 * member detection observed up to and including one satellite observation: the outline as
 * it stood once that overpass had been seen. The last point is therefore the event's
 * current outline, drawn from the same detections with the same parameters, byte for byte.
 *
 * **An observation.** The outline-drawing detections, ordered by acquisition time, split
 * wherever two consecutive ones are more than `observationGapMs` apart. One overpass takes a
 * few minutes to sweep an event; the next one is most of an hour away at best, so a gap of
 * a quarter of an hour separates passes without ever splitting one. A point is dated by its
 * observation's last acquisition instant. Detections from sources that draw no outline
 * (SLSTR, geostationary) are passed to the drawing but never start a point of their own.
 *
 * **Bounded.** An event seen on more than `maxPoints` overpasses keeps its first and last
 * observation and an even spread in between (`thinned`); each kept point is still drawn
 * from all detections up to it, so thinning loses resolution in time, never area.
 *
 * Descriptive only: the series says what the satellites saw and when, never where the fire
 * is going. The area keeps its band and the edge its uncertainty, as on the outline itself.
 */

import type { FireOutlineValues } from '../config/fire-outline.js';
import { formatCanonicalDegrees } from '../clustering/geometry.js';
import type { EpochMs } from '../ports/clock.js';
import { drawFireOutline, type OutlineDetection, type OutlineGeometry } from './fire-outline.js';

/** A member detection with its acquisition instant (`acq_ts`). */
export interface SeriesDetection extends OutlineDetection {
  readonly observedAt: EpochMs;
}

export interface OutlineSeriesPoint {
  /** The last acquisition instant of the observation this point closes. */
  readonly at: EpochMs;
  readonly areaHa: number;
  readonly areaLowHa: number;
  readonly areaHighHa: number;
  readonly edgeUncertaintyKm: number;
  /** Detections whose footprints were drawn into this point's outline. */
  readonly footprints: number;
  /** Area-weighted centroid of the outline, 5-dp degrees. */
  readonly centroid: { readonly lat: number; readonly lon: number };
}

export interface OutlineSeries {
  /** Oldest first, strictly increasing in `at`. Empty when no detection draws an outline. */
  readonly points: readonly OutlineSeriesPoint[];
  /** True when observations were left out to stay within `maxPoints`. */
  readonly thinned: boolean;
}

export interface OutlineSeriesOptions {
  /** Consecutive outline detections further apart than this start a new observation. */
  readonly observationGapMs: number;
  readonly maxPoints: number;
}

export const DEFAULT_OUTLINE_SERIES_OPTIONS: OutlineSeriesOptions = Object.freeze({
  observationGapMs: 15 * 60_000,
  maxPoints: 48,
});

export function buildOutlineSeries(
  detections: readonly SeriesDetection[],
  params: FireOutlineValues,
  options: OutlineSeriesOptions = DEFAULT_OUTLINE_SERIES_OPTIONS,
): OutlineSeries {
  checkOptions(options);
  for (const d of detections) {
    if (!Number.isFinite(d.observedAt)) {
      throw new RangeError(`detection ${d.uid} has a non-finite observation time`);
    }
  }

  const ends = observationEnds(
    detections.filter((d) => drawsOutline(d.sourceId, params)).map((d) => d.observedAt),
    options.observationGapMs,
  );
  const kept = thin(ends, options.maxPoints);

  const points: OutlineSeriesPoint[] = [];
  for (const at of kept) {
    const outline = drawFireOutline(
      detections.filter((d) => d.observedAt <= at),
      params,
    );
    if (
      outline.geometry === null ||
      outline.areaHa === null ||
      outline.areaLowHa === null ||
      outline.areaHighHa === null ||
      outline.edgeUncertaintyKm === null
    ) {
      continue;
    }
    points.push({
      at,
      areaHa: outline.areaHa,
      areaLowHa: outline.areaLowHa,
      areaHighHa: outline.areaHighHa,
      edgeUncertaintyKm: outline.edgeUncertaintyKm,
      footprints: outline.footprints,
      centroid: outlineCentroid(outline.geometry),
    });
  }
  return { points, thinned: kept.length < ends.length };
}

/** Same rule as the drawing: a source draws when its footprint entry is not null. */
function drawsOutline(sourceId: string, params: FireOutlineValues): boolean {
  const bySource: Readonly<Record<string, unknown>> = params.footprintBySource;
  const rule = bySource[sourceId];
  return rule !== undefined && rule !== null;
}

/** The last instant of each observation, ascending. */
function observationEnds(times: readonly EpochMs[], gapMs: number): EpochMs[] {
  const sorted = times.toSorted((a, b) => a - b);
  const ends: EpochMs[] = [];
  for (let k = 0; k < sorted.length; k += 1) {
    const t = sorted[k] as EpochMs;
    const next = sorted[k + 1];
    if (next === undefined || next - t > gapMs) ends.push(t);
  }
  return ends;
}

/** The first and the last, and an even spread in between. */
function thin(ends: readonly EpochMs[], maxPoints: number): readonly EpochMs[] {
  if (ends.length <= maxPoints) return ends;
  if (maxPoints === 1) return [ends.at(-1) as EpochMs];
  const out: EpochMs[] = [];
  const last = ends.length - 1;
  for (let k = 0; k < maxPoints; k += 1) {
    // Integer arithmetic, so the same input always keeps the same observations.
    out.push(ends[Math.floor((k * last) / (maxPoints - 1))] as EpochMs);
  }
  return out;
}

/**
 * Area-weighted centroid of the outer rings (an outline has no holes), in degrees. Over the
 * few kilometres of one event the longitudinal scale is constant to well under a pixel, and
 * a centroid is unchanged by scaling one axis, so working in degrees is exact enough.
 */
export function outlineCentroid(geometry: OutlineGeometry): {
  readonly lat: number;
  readonly lon: number;
} {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (const polygon of geometry.coordinates) {
    const ring = polygon[0];
    if (ring === undefined) continue;
    // Relative to the ring's first vertex, so the products stay small.
    const [ox, oy] = ring[0] ?? [0, 0];
    for (let k = 0; k + 1 < ring.length; k += 1) {
      const [x0, y0] = ring[k] as readonly [number, number];
      const [x1, y1] = ring[k + 1] as readonly [number, number];
      const ax = x0 - ox;
      const ay = y0 - oy;
      const bx = x1 - ox;
      const by = y1 - oy;
      const cross = ax * by - bx * ay;
      area += cross;
      cx += (ax + bx) * cross + 3 * ox * cross;
      cy += (ay + by) * cross + 3 * oy * cross;
    }
  }
  if (area === 0) throw new RangeError('outline has no area to take a centroid of');
  return {
    lat: Number(formatCanonicalDegrees(cy / (3 * area))),
    lon: Number(formatCanonicalDegrees(cx / (3 * area))),
  };
}

function checkOptions(options: OutlineSeriesOptions): void {
  if (!Number.isFinite(options.observationGapMs) || options.observationGapMs < 0) {
    throw new RangeError('observationGapMs must be a finite non-negative number');
  }
  if (!Number.isSafeInteger(options.maxPoints) || options.maxPoints < 1) {
    throw new RangeError('maxPoints must be a positive safe integer');
  }
}
