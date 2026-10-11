/**
 * Detection → EFFIS perimeter label join (TASKS D7; review 11 §4.1; GATES §2 "metric
 * population").
 *
 * A detection d matches burnt area F iff
 *
 *   d lies within max(ε_source(d), 1 km) of F's perimeter (inside counts as distance 0)
 *   and acq_ts(d) ∈ [F.start − 1 d, F.end + 3 d], both ends inclusive.
 *
 * and then:
 *
 * - exactly one match → `labeled` with that fire;
 * - two or more → `ambiguous`: excluded from every pairwise metric, kept for event counts
 *   (two touching perimeters cannot say which front a pixel between them belongs to);
 * - none → `unlabeled`, and **never a negative**. EFFIS maps from ~30 ha; an unlabelled
 *   detection is a fire too small to map, an agricultural burn, an industrial source or
 *   noise, and the fit has no way to tell which.
 *
 * ε here is resolved under a fixed baseline config, not under the config being scored.
 * 11 §4.1 writes ε_source(d) without saying which ε, and the two readings differ in what
 * the grid measures: if the label buffer followed the candidate ε, every grid cell would
 * score itself against a different labelled population and the metric surface would
 * partly measure the label join. Fixing it makes the population an input of the fit, the
 * same for all ~600 runs. (Recorded as a founder decision in the fit report.)
 *
 * Geometry: EFFIS outer rings only, holes ignored — the convention the DS-6 selection
 * reads the same files under (`infra/geodata/effis-ba-candidates.ts`). Distances are on
 * the clustering's own planar metric, so "within ε" means the same thing here as in the
 * engine, quantised through the same `withinKm`.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { ClusteringParams, PlanarMetric } from '../clustering/clustering-params.js';
import { epsKmFor } from '../clustering/eps.js';
import { parseCanonicalDegrees, withinKm } from '../clustering/geometry.js';
import { epochMsFromIso } from '../ports/clock.js';
import type { FitParams } from './fit-params.js';

const DAY_MS = 86_400_000;

/** A detection as the fit reads it: the clustering input minus `available_at`. */
export interface FitDetection {
  readonly detectionUid: string;
  readonly source: SourceId;
  readonly acqTsIso: string;
  readonly latCanonical: string;
  readonly lonCanonical: string;
  readonly scanKm: number | null;
  readonly trackKm: number | null;
}

/** `[lon, lat]`, GeoJSON order. */
export type LonLat = readonly [number, number];

/** One labelled fire: an EFFIS burnt-area perimeter (DS-3). */
export interface LabelPerimeter {
  /** Unique across the whole label set — the parser prefixes the layer (`2024/239071`). */
  readonly fireId: string;
  /** `FIREDATE`, epoch ms. */
  readonly startMs: number;
  /** `FINALDATE` (or `FIREDATE` when absent), epoch ms. */
  readonly endMs: number;
  readonly areaHa: number;
  /** Outer rings only. */
  readonly rings: readonly (readonly LonLat[])[];
}

export type DetectionLabel =
  | { readonly kind: 'labeled'; readonly fireId: string }
  | { readonly kind: 'ambiguous'; readonly fireIds: readonly string[] }
  | { readonly kind: 'unlabeled' };

export interface LabelJoinSummary {
  readonly labeled: number;
  readonly ambiguous: number;
  readonly unlabeled: number;
}

const CELL_DEG = 0.1;

interface IndexedPerimeter {
  readonly perimeter: LabelPerimeter;
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Labels every detection, in input order. Pure; the perimeter index is rebuilt per call
 * because a call is one season's worth of rows, and keeping it out of module state keeps
 * the function a function.
 */
export function labelDetections(
  detections: readonly FitDetection[],
  perimeters: readonly LabelPerimeter[],
  params: FitParams,
  labelEps: ClusteringParams,
): readonly DetectionLabel[] {
  const metric = labelEps.metric;
  const buffers = detections.map((d) =>
    Math.max(
      epsKmFor(d.source, { scanKm: d.scanKm, trackKm: d.trackKm }, labelEps).km,
      params.labelJoin.bufferFloorKm,
    ),
  );
  const maxBufferKm = buffers.reduce((max, km) => Math.max(max, km), 0);
  const index = buildIndex(perimeters, params, maxBufferKm, metric);

  return detections.map((detection, i) => {
    const lat = parseCanonicalDegrees(detection.latCanonical, 'latitude');
    const lon = parseCanonicalDegrees(detection.lonCanonical, 'longitude');
    const acqTs = epochMsFromIso(detection.acqTsIso);
    const bufferKm = buffers[i] as number;
    const matches = new Set<string>();
    for (const entry of index.get(cellKey(lat, lon)) ?? []) {
      if (acqTs < entry.fromMs || acqTs > entry.toMs) continue;
      if (matches.has(entry.perimeter.fireId)) continue;
      if (withinPerimeter(lon, lat, entry.perimeter, bufferKm, metric)) {
        matches.add(entry.perimeter.fireId);
      }
    }
    if (matches.size === 0) return { kind: 'unlabeled' } as const;
    const fireIds = [...matches].sort();
    if (fireIds.length === 1) return { kind: 'labeled', fireId: fireIds[0] as string } as const;
    return { kind: 'ambiguous', fireIds } as const;
  });
}

export function summarizeLabels(labels: readonly DetectionLabel[]): LabelJoinSummary {
  let labeled = 0;
  let ambiguous = 0;
  let unlabeled = 0;
  for (const label of labels) {
    if (label.kind === 'labeled') labeled += 1;
    else if (label.kind === 'ambiguous') ambiguous += 1;
    else unlabeled += 1;
  }
  return { labeled, ambiguous, unlabeled };
}

function cellKey(lat: number, lon: number): string {
  return `${String(Math.floor(lat / CELL_DEG))}:${String(Math.floor(lon / CELL_DEG))}`;
}

/**
 * A coarse grid over each perimeter's bounding box, widened by the largest buffer any
 * detection uses. A cell list per detection is then a superset of its candidates, and
 * the exact test below decides. Without it the join is detections × perimeters — 400k ×
 * 9k over the full corpus.
 */
function buildIndex(
  perimeters: readonly LabelPerimeter[],
  params: FitParams,
  maxBufferKm: number,
  metric: PlanarMetric,
): Map<string, IndexedPerimeter[]> {
  const index = new Map<string, IndexedPerimeter[]>();
  for (const perimeter of perimeters) {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const ring of perimeter.rings) {
      for (const [lon, lat] of ring) {
        w = Math.min(w, lon);
        e = Math.max(e, lon);
        s = Math.min(s, lat);
        n = Math.max(n, lat);
      }
    }
    if (!Number.isFinite(w)) continue;
    const padLat = maxBufferKm / metric.kmPerDegreeLat;
    // The smallest km-per-degree over the box gives the widest padding in degrees, so
    // the pad never under-covers at the box's poleward edge.
    const padLon = maxBufferKm / kmPerDegreeLon(Math.max(Math.abs(s), Math.abs(n)), metric);
    const entry: IndexedPerimeter = {
      perimeter,
      fromMs: perimeter.startMs - params.labelJoin.daysBefore * DAY_MS,
      toMs: perimeter.endMs + params.labelJoin.daysAfter * DAY_MS,
    };
    const lat0 = Math.floor((s - padLat) / CELL_DEG);
    const lat1 = Math.floor((n + padLat) / CELL_DEG);
    const lon0 = Math.floor((w - padLon) / CELL_DEG);
    const lon1 = Math.floor((e + padLon) / CELL_DEG);
    for (let a = lat0; a <= lat1; a += 1) {
      for (let b = lon0; b <= lon1; b += 1) {
        const key = `${String(a)}:${String(b)}`;
        const list = index.get(key);
        if (list === undefined) index.set(key, [entry]);
        else list.push(entry);
      }
    }
  }
  return index;
}

function kmPerDegreeLon(lat: number, metric: PlanarMetric): number {
  return (
    metric.kmPerDegreeLonAtReference +
    metric.kmPerDegreeLonPerDegreeLat * (lat - metric.referenceLatDeg)
  );
}

/** Inside any outer ring, or within `bufferKm` of any ring edge (inclusive). */
export function withinPerimeter(
  lon: number,
  lat: number,
  perimeter: LabelPerimeter,
  bufferKm: number,
  metric: PlanarMetric,
): boolean {
  for (const ring of perimeter.rings) {
    if (insideRing(lon, lat, ring)) return true;
  }
  for (const ring of perimeter.rings) {
    if (withinKm(distanceToRingKm(lon, lat, ring, metric), bufferKm, metric)) return true;
  }
  return false;
}

/** Even-odd ray cast in degree space. A ring closed or not, the last edge is implied. */
function insideRing(lon: number, lat: number, ring: readonly LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i] as LonLat;
    const [xj, yj] = ring[j] as LonLat;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Point-to-polyline distance on a local tangent plane centred on the point. The scale is
 * the metric's, evaluated at the point's latitude; over a ring a few kilometres across
 * that differs from `distanceKm`'s mean-latitude scale by well under a metre.
 */
function distanceToRingKm(
  lon: number,
  lat: number,
  ring: readonly LonLat[],
  metric: PlanarMetric,
): number {
  const kx = kmPerDegreeLon(lat, metric);
  const ky = metric.kmPerDegreeLat;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [ax, ay] = ring[j] as LonLat;
    const [bx, by] = ring[i] as LonLat;
    const x1 = (ax - lon) * kx;
    const y1 = (ay - lat) * ky;
    const x2 = (bx - lon) * kx;
    const y2 = (by - lat) * ky;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, -(x1 * dx + y1 * dy) / lengthSquared));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    best = Math.min(best, Math.sqrt(px * px + py * py));
  }
  return best;
}
