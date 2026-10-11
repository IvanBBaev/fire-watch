/**
 * One season's evaluation frame: everything about the metric population that does not
 * depend on the clustering config being scored (TASKS D7).
 *
 * A grid sweep scores ~150 configs over the same rows. The label join, the per-fire
 * bookkeeping and the hard-negative pair list are functions of the data and of the fit
 * rules only, so they are built once per season here and every config is scored against
 * the same frame — which is also what makes "the labelled population is identical across
 * the grid" a structural fact rather than a hope.
 *
 * A season is a UTC calendar year of `acq_ts` (11 §9.1). The fit clusters each season on
 * its own, so no pair, event or fire ever spans two seasons; a perimeter whose window
 * straddles New Year labels detections in both, as two separate fires-in-season.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { ClusteringParams } from '../clustering/clustering-params.js';
import { isAttachOnly } from '../clustering/eps.js';
import {
  distanceKm,
  parseCanonicalDegrees,
  withinKm,
  type Coordinate,
} from '../clustering/geometry.js';
import { epochMsFromIso } from '../ports/clock.js';
import { stratumOf, type FitParams } from './fit-params.js';
import {
  labelDetections,
  summarizeLabels,
  type FitDetection,
  type LabelJoinSummary,
  type LabelPerimeter,
} from './label-join.js';

const DAY_MS = 86_400_000;

/** `fireIndex` sentinel values. */
export const UNLABELED = -1;
export const AMBIGUOUS = -2;

export interface FrameFire {
  readonly fireId: string;
  readonly areaHa: number;
  readonly stratum: string;
  readonly gated: boolean;
}

export interface SeasonFrame {
  readonly season: number;
  /** In `acq_ts` order, then `detection_uid` — the replay's input order. */
  readonly detections: readonly FitDetection[];
  readonly acqMs: readonly number[];
  readonly coordinates: readonly Coordinate[];
  readonly attachOnly: readonly boolean[];
  /** Index into `fires`, or {@link UNLABELED} / {@link AMBIGUOUS}. */
  readonly fireIndex: readonly number[];
  /** Only fires with at least one labelled detection this season, by `fireId`. */
  readonly fires: readonly FrameFire[];
  /**
   * Hard negatives (11 §4.2): labelled detection pairs `(a[k], b[k])`, `a < b`, from
   * different fires, within `hardNegative.withinKm` (inclusive, on the quantised grid)
   * and `hardNegative.withinDays` (inclusive) of each other.
   */
  readonly hardNegatives: { readonly a: readonly number[]; readonly b: readonly number[] };
  readonly labels: LabelJoinSummary;
  readonly sources: readonly SourceId[];
}

/** The UTC year of an ISO instant — the season a detection belongs to. */
export function seasonOf(acqTsIso: string): number {
  return Number(acqTsIso.slice(0, 4));
}

export function buildSeasonFrame(
  season: number,
  detections: readonly FitDetection[],
  perimeters: readonly LabelPerimeter[],
  params: FitParams,
  labelEps: ClusteringParams,
): SeasonFrame {
  const rows = detections
    .filter((d) => seasonOf(d.acqTsIso) === season)
    .map((d) => ({ d, ms: epochMsFromIso(d.acqTsIso) }))
    .sort((x, y) =>
      x.ms !== y.ms
        ? x.ms - y.ms
        : x.d.detectionUid < y.d.detectionUid
          ? -1
          : x.d.detectionUid > y.d.detectionUid
            ? 1
            : 0,
    );
  const ordered = rows.map((r) => r.d);
  const acqMs = rows.map((r) => r.ms);
  const coordinates = ordered.map((d) => ({
    lat: parseCanonicalDegrees(d.latCanonical, 'latitude'),
    lon: parseCanonicalDegrees(d.lonCanonical, 'longitude'),
  }));
  const labels = labelDetections(ordered, perimeters, params, labelEps);

  const byId = new Map(perimeters.map((p) => [p.fireId, p]));
  const usedIds = [
    ...new Set(labels.flatMap((l) => (l.kind === 'labeled' ? [l.fireId] : []))),
  ].sort();
  const fires: FrameFire[] = usedIds.map((fireId) => {
    const perimeter = byId.get(fireId);
    if (perimeter === undefined) throw new Error(`label names unknown fire ${fireId}`);
    const stratum = stratumOf(perimeter.areaHa, params);
    const gated = params.sizeStrata.find((s) => s.id === stratum)?.gated ?? false;
    return { fireId, areaHa: perimeter.areaHa, stratum, gated };
  });
  const fireSlot = new Map(fires.map((f, i) => [f.fireId, i]));
  const fireIndex = labels.map((l) =>
    l.kind === 'labeled'
      ? (fireSlot.get(l.fireId) as number)
      : l.kind === 'ambiguous'
        ? AMBIGUOUS
        : UNLABELED,
  );

  return {
    season,
    detections: ordered,
    acqMs,
    coordinates,
    attachOnly: ordered.map((d) => isAttachOnly(d.source)),
    fireIndex,
    fires,
    hardNegatives: hardNegativePairs(acqMs, coordinates, fireIndex, params, labelEps),
    labels: summarizeLabels(labels),
    sources: [...new Set(ordered.map((d) => d.source))].sort(),
  };
}

/**
 * Bucketed pair search. Cells are `withinKm` tall and at least `withinKm` wide at the
 * frame's most poleward latitude (where a degree of longitude is shortest), and
 * `withinDays` long, so every qualifying pair lies in the same or an adjacent cell; the
 * exact test then decides. Pairs are emitted with `a < b`, each once.
 */
function hardNegativePairs(
  acqMs: readonly number[],
  coordinates: readonly Coordinate[],
  fireIndex: readonly number[],
  params: FitParams,
  clustering: ClusteringParams,
): { a: number[]; b: number[] } {
  const metric = clustering.metric;
  const { withinKm: boundKm, withinDays } = params.hardNegative;
  const windowMs = withinDays * DAY_MS;
  const labelled: number[] = [];
  let maxAbsLat = 0;
  fireIndex.forEach((f, i) => {
    if (f >= 0) {
      labelled.push(i);
      maxAbsLat = Math.max(maxAbsLat, Math.abs((coordinates[i] as Coordinate).lat));
    }
  });
  const a: number[] = [];
  const b: number[] = [];
  if (labelled.length < 2) return { a, b };

  const kmPerDegLonMin =
    metric.kmPerDegreeLonAtReference +
    metric.kmPerDegreeLonPerDegreeLat * (maxAbsLat - metric.referenceLatDeg);
  if (!(kmPerDegLonMin > 0)) {
    throw new RangeError('hard-negative search: data lies outside the planar metric’s domain');
  }
  const latCell = boundKm / metric.kmPerDegreeLat;
  const lonCell = boundKm / kmPerDegLonMin;
  const key = (y: number, x: number, t: number): string => `${String(y)}:${String(x)}:${String(t)}`;
  const cellOf = (i: number): [number, number, number] => {
    const c = coordinates[i] as Coordinate;
    return [
      Math.floor(c.lat / latCell),
      Math.floor(c.lon / lonCell),
      Math.floor((acqMs[i] as number) / windowMs),
    ];
  };
  const buckets = new Map<string, number[]>();
  for (const i of labelled) {
    const [y, x, t] = cellOf(i);
    const k = key(y, x, t);
    const list = buckets.get(k);
    if (list === undefined) buckets.set(k, [i]);
    else list.push(i);
  }
  for (const i of labelled) {
    const [y, x, t] = cellOf(i);
    const fi = fireIndex[i] as number;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dt = -1; dt <= 1; dt += 1) {
          for (const j of buckets.get(key(y + dy, x + dx, t + dt)) ?? []) {
            if (j <= i || fireIndex[j] === fi) continue;
            if (Math.abs((acqMs[j] as number) - (acqMs[i] as number)) > windowMs) continue;
            const km = distanceKm(
              coordinates[i] as Coordinate,
              coordinates[j] as Coordinate,
              metric,
            );
            if (!withinKm(km, boundKm, metric)) continue;
            a.push(i);
            b.push(j);
          }
        }
      }
    }
  }
  return { a, b };
}
