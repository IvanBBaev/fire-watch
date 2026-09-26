/**
 * Where a watch zone is allowed to say it is (ADR-004 D8, A1.10; 05 §5.3.2; 07 §5.5.1).
 *
 * A watch zone is the single most sensitive thing this system holds. A fire map is public;
 * "this account watches a 2 km circle round a house in Банско" is a home address with a
 * login attached. D8 answers that with three layers, and this module is the pure half of
 * two of them:
 *
 *   1. **Coarsening.** With the setting ON — the default, and 07 §5.5.1 makes it a user
 *      toggle rather than a policy — the centre is snapped to a ~1 km grid *before* anything
 *      else sees it. Not stored precise and rounded on read: a centre that was never written
 *      cannot leak from a backup.
 *   2. **The coarse index.** Candidate lookup runs on the containing ~5 km cell id, stored in
 *      clear (05 §5.3.2), and the centre itself is ciphertext. A dump of `watch_zones` yields
 *      5 km cells, not homes. The cipher is a port; see `ports/zone-centre-cipher.ts`.
 *   3. **Encryption** — the adapter's job, and not this module's, because the core has no
 *      platform crypto.
 *
 * ## Why a degree grid, and why integer cell indices
 *
 * The snap has to be a *function*: the same click must land in the same cell on every
 * engine and every replay, or a zone re-saved unchanged would move. So it is `floor(deg ×
 * cellsPerDegree)` — one multiplication and one floor, both exactly specified in ECMAScript
 * — and the cell centre is `(index + ½) / cellsPerDegree`. No trigonometry, for the reason
 * `clustering/geometry.ts` gives: `Math.cos` is implementation-approximated, and a cell
 * boundary that moved by one ulp between builds would move a zone.
 *
 * A degree grid is not an equal-area grid: at Bulgaria's latitudes a 0.01° cell is ~1.11 km
 * north–south and ~0.82 km east–west. That is the "~1 km" D8 means — the worst-case
 * displacement is half the cell diagonal, ~0.69 km at 42°N and ~0.70 km at the envelope's southern edge, which is what A1.10's 2 km floor
 * is sized against ("coarsening error ≪ radius"). {@link maxCoarseningErrorKm} states it so
 * the test can hold the two numbers against each other rather than trusting this comment.
 *
 * The index grid nests the coarse one exactly — 100 is a multiple of 20 — so a coarsened
 * centre is always strictly inside its index cell and never on a shared edge.
 *
 * ## The stored centre is the only centre
 *
 * A1.10: alert geometry and distance bands are computed **from the stored centre**. With
 * coarsening on, that is the snapped one; there is no "precise copy for the engine". 05
 * §5.3.2's "decrypt candidates for the precise ST_DWithin test" is precise *relative to the
 * index cell*, not relative to the user's click — the click is gone by then, by design.
 */

import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';
import type { BoundingBox } from '../config/polling-bbox.js';
import { alertableEnvelope } from '../config/polling-bbox.js';
import type { Coordinate } from '../clustering/geometry.js';

export interface ZoneGridParams {
  /** Coarsening cells per degree. 100 → 0.01°, ~1.11 × 0.82 km at 42°N. */
  readonly coarseCellsPerDegree: number;
  /** Index cells per degree. 20 → 0.05°, the "~5 km grid cell" of 05 §5.3.2. */
  readonly indexCellsPerDegree: number;
  /** A1.10: unconditional, independent of the coarsening toggle. Metres. */
  readonly minRadiusM: number;
  /** 07 §5.5.1's slider ceiling, and the radius the polling-bbox buffer is sized with. */
  readonly maxRadiusM: number;
  /** 07 §5.5.1's slider default. */
  readonly defaultRadiusM: number;
}

/**
 * Versioned, because a zone row records the grid it was indexed on (`grid_version`), and a
 * refit of either step is a re-index of every live zone rather than an edit to a constant.
 */
export const ZONE_GRID: VersionedConfig<ZoneGridParams> = defineConfig(
  'zone_grid',
  'zone_grid_v1',
  {
    coarseCellsPerDegree: 100,
    indexCellsPerDegree: 20,
    minRadiusM: 2_000,
    maxRadiusM: 30_000,
    defaultRadiusM: 10_000,
  } as const,
);

/** Kilometres per degree of latitude — the same figure `polling-bbox.ts` uses. */
const KM_PER_DEGREE_LAT = 111.32;

/** What a zone centre becomes before anything is written. */
export interface PreparedCentre {
  /** The centre that is encrypted, stored, and measured from. Never the click, when coarsened. */
  readonly stored: Coordinate;
  readonly coarsened: boolean;
  /** The clear-text candidate-lookup key. See {@link indexCellKey}. */
  readonly indexCell: string;
  readonly gridVersion: string;
}

/**
 * Validates a requested centre and turns it into the one that will be stored.
 *
 * The envelope check is not decoration: a zone outside Bulgaria + 100 km is outside the
 * area the poll is sized to cover (DATA-SOURCES §A9), so it would be a zone that can never
 * alert — and a user who believes they are protected is worse off than one who knows they
 * are not.
 */
export function prepareCentre(
  requested: Coordinate,
  options: { readonly coarsen: boolean; readonly envelope?: BoundingBox },
  grid: VersionedConfig<ZoneGridParams> = ZONE_GRID,
): PreparedCentre {
  assertCoordinate(requested);
  const envelope = options.envelope ?? alertableEnvelope();
  if (!insideEnvelope(requested, envelope)) {
    throw new RangeError('zone centre lies outside the alertable area');
  }
  const stored = options.coarsen ? coarsenCentre(requested, grid.values) : requested;
  return Object.freeze({
    stored: Object.freeze({ lat: stored.lat, lon: stored.lon }),
    coarsened: options.coarsen,
    indexCell: indexCellKey(stored, grid.values),
    gridVersion: grid.version,
  });
}

/**
 * Snaps a point to the centre of its coarsening cell. Idempotent: a coarsened centre is
 * strictly inside its own cell, so snapping it again returns it unchanged — which is what
 * lets a zone be re-saved without drifting.
 */
export function coarsenCentre(
  point: Coordinate,
  params: ZoneGridParams = ZONE_GRID.values,
): Coordinate {
  const perDegree = params.coarseCellsPerDegree;
  return {
    lat: cellCentre(Math.floor(point.lat * perDegree), perDegree),
    lon: cellCentre(Math.floor(point.lon * perDegree), perDegree),
  };
}

/**
 * The ~5 km index cell containing a point, as `<latIndex>:<lonIndex>`.
 *
 * Deliberately an opaque pair of integers rather than a geohash or a rendered coordinate:
 * the column is readable by anyone who can read the table, and "41.95,23.40" in a dump
 * reads as a place in a way "838:468" does not — though both are, and must be treated as,
 * location data at 5 km resolution.
 */
export function indexCellKey(point: Coordinate, params: ZoneGridParams = ZONE_GRID.values): string {
  const perDegree = params.indexCellsPerDegree;
  return `${Math.floor(point.lat * perDegree)}:${Math.floor(point.lon * perDegree)}`;
}

/**
 * Every index cell a zone of up to `radiusM` could occupy and still reach `point`.
 *
 * The lookup direction is "a fire is here; which zones might contain it?", so the cells are
 * those whose zones' *centres* could lie within the radius — the box of `point ± radius`,
 * plus one cell of slack on every side. The slack is what makes this a superset without
 * trusting `Math.cos` to the last bit: it is a candidate filter, and the exact distance test
 * that follows it is what decides.
 */
export function indexCellsWithin(
  point: Coordinate,
  radiusM: number,
  params: ZoneGridParams = ZONE_GRID.values,
): readonly string[] {
  assertCoordinate(point);
  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new RangeError(`candidate radius must be a non-negative number, got ${String(radiusM)}`);
  }
  const perDegree = params.indexCellsPerDegree;
  const km = radiusM / 1000;
  const dLat = km / KM_PER_DEGREE_LAT;
  const poleward = Math.min(Math.abs(point.lat) + dLat, 89);
  const dLon = km / (KM_PER_DEGREE_LAT * Math.cos((poleward * Math.PI) / 180));

  const latFrom = Math.floor((point.lat - dLat) * perDegree) - 1;
  const latTo = Math.floor((point.lat + dLat) * perDegree) + 1;
  const lonFrom = Math.floor((point.lon - dLon) * perDegree) - 1;
  const lonTo = Math.floor((point.lon + dLon) * perDegree) + 1;

  const cells: string[] = [];
  for (let lat = latFrom; lat <= latTo; lat += 1) {
    for (let lon = lonFrom; lon <= lonTo; lon += 1) {
      cells.push(`${lat}:${lon}`);
    }
  }
  return cells;
}

/**
 * A1.10's radius rule. Whole metres, because the column is an integer and a fractional
 * radius that the database silently rounded would be a zone that is not the one drawn.
 */
export function assertRadiusM(radiusM: number, params: ZoneGridParams = ZONE_GRID.values): void {
  if (!Number.isInteger(radiusM)) {
    throw new RangeError(`zone radius must be whole metres, got ${String(radiusM)}`);
  }
  if (radiusM < params.minRadiusM || radiusM > params.maxRadiusM) {
    throw new RangeError(
      `zone radius must lie within ${params.minRadiusM}–${params.maxRadiusM} m, got ${radiusM}`,
    );
  }
}

/**
 * Half the coarsening cell's diagonal at a latitude: the furthest a stored centre can be
 * from the click it came from. Used by the test that holds A1.10's "coarsening error ≪
 * radius" to a number; nothing at runtime needs it.
 */
export function maxCoarseningErrorKm(
  latitude: number,
  params: ZoneGridParams = ZONE_GRID.values,
): number {
  const stepDeg = 1 / params.coarseCellsPerDegree;
  const northSouth = stepDeg * KM_PER_DEGREE_LAT;
  const eastWest = stepDeg * KM_PER_DEGREE_LAT * Math.cos((latitude * Math.PI) / 180);
  return Math.sqrt(northSouth * northSouth + eastWest * eastWest) / 2;
}

export function assertCoordinate(point: Coordinate): void {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new RangeError('zone latitude must be a finite number within [-90, 90]');
  }
  if (!Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
    throw new RangeError('zone longitude must be a finite number within [-180, 180]');
  }
}

function insideEnvelope(point: Coordinate, box: BoundingBox): boolean {
  return (
    point.lat >= box.south &&
    point.lat <= box.north &&
    point.lon >= box.west &&
    point.lon <= box.east
  );
}

function cellCentre(index: number, perDegree: number): number {
  return (index + 0.5) / perDegree;
}
