/**
 * The synthetic zone lattice CP1 grades shadow-PCR against (GATES §4 CP1).
 *
 * "the side-effect-free alert-decision function returns an alert for the **synthetic grid
 * zone** containing the perimeter centroid — default-sensitivity zones on a fixed 10 km
 * lattice over the AOI, pinned as versioned config-as-data in place of subscribed zones."
 *
 * In October 2026 there are no subscribed zones — WP7 does not exist — so the lattice is
 * how criterion (b) is computable "from WP1 + WP2 outputs alone". Two properties make it
 * usable as evidence:
 *
 *   - **It is a function, not a table.** A zone is derived from its indices, so the CP1
 *     report cites `qa_metrics_v1` and a per-perimeter table rather than a 4,000-row zone
 *     dump that could be edited after the grading.
 *   - **It is exact.** Cell edges come from the pinned bounds and the pitch divided by the
 *     planar metric's kilometres-per-degree — no trigonometry, so no engine-dependent
 *     last bits deciding which cell a centroid near an edge belongs to.
 *
 * The zones are *default-sensitivity*: the score floor and the quiet-hours window come
 * from `alert_gating_v1`, so the lattice cannot drift away from what a real default zone
 * would have decided.
 */

import { ALERT_GATING, type AlertGatingParams } from '../config/alert-gating.js';
import type { AlertZone } from '../alerts/alert-decision.js';
import { CLUSTERING_PARAMS, type PlanarMetric } from '../clustering/clustering-params.js';
import type { Coordinate } from '../clustering/geometry.js';
import type { BoundingBox } from '../config/polling-bbox.js';
import {
  QA_METRICS,
  type QaMetricsParams,
  type SyntheticZoneLattice,
} from './qa-metrics-params.js';

export interface GridZone {
  readonly zoneId: string;
  /** 0-based, west to east. */
  readonly col: number;
  /** 0-based, south to north. */
  readonly row: number;
  readonly bounds: BoundingBox;
  readonly centre: Coordinate;
}

export interface LatticeShape {
  readonly cols: number;
  readonly rows: number;
  readonly lonStepDeg: number;
  readonly latStepDeg: number;
  /** How far the lattice actually reaches; `≥` the configured bounds, never less. */
  readonly coverage: BoundingBox;
}

/**
 * Cell counts are rounded **up**, so the lattice covers at least the configured box. A
 * `floor` would leave a strip of the AOI in no zone at all, and a fire there would be
 * scored as un-alerted for want of a zone to alert rather than for want of a decision.
 */
export function latticeShape(
  lattice: SyntheticZoneLattice = QA_METRICS.values.lattice,
  metric: PlanarMetric = CLUSTERING_PARAMS.values.metric,
): LatticeShape {
  const latStepDeg = lattice.pitchKm / metric.kmPerDegreeLat;
  const lonStepDeg = lattice.pitchKm / metric.kmPerDegreeLonAtReference;
  const cols = Math.ceil((lattice.bounds.east - lattice.bounds.west) / lonStepDeg);
  const rows = Math.ceil((lattice.bounds.north - lattice.bounds.south) / latStepDeg);
  if (cols < 1 || rows < 1) {
    throw new RangeError('synthetic zone lattice bounds enclose no cell');
  }
  const maxIndex = Math.max(cols, rows) - 1;
  if (String(maxIndex).length > lattice.idDigits) {
    throw new RangeError(
      `synthetic zone index ${String(maxIndex)} does not fit ${String(lattice.idDigits)} digits; ` +
        'a lattice that outgrows its id format needs a config version bump, not a wider pad',
    );
  }
  return Object.freeze({
    cols,
    rows,
    lonStepDeg,
    latStepDeg,
    coverage: Object.freeze({
      west: lattice.bounds.west,
      south: lattice.bounds.south,
      east: lattice.bounds.west + cols * lonStepDeg,
      north: lattice.bounds.south + rows * latStepDeg,
    }),
  });
}

/**
 * `qa_grid-c012-r034`. Fixed-width and zero-padded so the lexical order of the ids is the
 * geographic order of the cells — a report sorted by zone id reads west to east.
 */
export function gridZoneId(
  col: number,
  row: number,
  lattice: SyntheticZoneLattice = QA_METRICS.values.lattice,
): string {
  const pad = (value: number): string => String(value).padStart(lattice.idDigits, '0');
  return `${lattice.idPrefix}-c${pad(col)}-r${pad(row)}`;
}

/**
 * The cell containing `point`, or `null` when the point is outside the lattice.
 *
 * Cells are half-open: `[west + c·step, west + (c+1)·step)`. A point exactly on an
 * internal edge belongs to the cell to its east/north, which is an arbitrary but *pinned*
 * choice — the alternative is a coordinate that belongs to two zones, and shadow-PCR
 * would then have two answers for one perimeter.
 *
 * In exact arithmetic. The step is a division that does not land on a binary fraction, so
 * a coordinate reconstructed as `west + c·step` can divide back to a hair under `c` and
 * be placed one cell west of the edge it was built from. That is left alone rather than
 * patched with an epsilon: the placement is still a single, *deterministic* cell for a
 * given coordinate, which is all the metric needs, and an epsilon would only move the
 * knife-edge somewhere else while pretending the boundary is exact. Nothing downstream
 * distinguishes the two neighbours — both are ordinary default-sensitivity zones.
 */
export function gridZoneFor(
  point: Coordinate,
  params: QaMetricsParams = QA_METRICS.values,
  metric: PlanarMetric = CLUSTERING_PARAMS.values.metric,
): GridZone | null {
  const lattice = params.lattice;
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
    throw new RangeError(
      `grid zone lookup needs a finite coordinate, got ${String(point.lat)},${String(point.lon)}`,
    );
  }
  const shape = latticeShape(lattice, metric);
  const col = Math.floor((point.lon - lattice.bounds.west) / shape.lonStepDeg);
  const row = Math.floor((point.lat - lattice.bounds.south) / shape.latStepDeg);
  if (col < 0 || col >= shape.cols || row < 0 || row >= shape.rows) return null;
  const west = lattice.bounds.west + col * shape.lonStepDeg;
  const south = lattice.bounds.south + row * shape.latStepDeg;
  return Object.freeze({
    zoneId: gridZoneId(col, row, lattice),
    col,
    row,
    bounds: Object.freeze({
      west,
      south,
      east: west + shape.lonStepDeg,
      north: south + shape.latStepDeg,
    }),
    centre: Object.freeze({
      lat: south + shape.latStepDeg / 2,
      lon: west + shape.lonStepDeg / 2,
    }),
  });
}

/**
 * The lattice cell as the alert decision sees it.
 *
 * `distanceKm` is a parameter rather than derived because `AlertZone` documents it as the
 * distance "to the event geometry", which this module has no access to and must not guess.
 * It is consulted only by the A1.12 nearer-zone tie-break, which cannot fire in a shadow
 * run with one zone per event.
 */
export function gridAlertZone(
  zone: GridZone,
  distanceKm: number,
  params: QaMetricsParams = QA_METRICS.values,
  gating: AlertGatingParams = ALERT_GATING.values,
): AlertZone {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new RangeError(`zone distance must be a non-negative number, got ${String(distanceKm)}`);
  }
  return Object.freeze({
    zoneId: zone.zoneId,
    // "Default-sensitivity" is A1.7's middle floor, the same 0.45 GLOSSARY §8's
    // "alertable event" is defined against. Read, never restated.
    minScore: gating.sensitivityFloors.likely,
    timezone: gating.quietHours.timezone,
    quietHoursStart: gating.quietHours.start,
    quietHoursEnd: gating.quietHours.end,
    newFireOverridesQuietHours: params.lattice.newFireOverridesQuietHours,
    distanceKm,
  });
}
