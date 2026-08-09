/**
 * `polling_bbox_v1` — the polled area as versioned data (DATA-SOURCES §A9).
 *
 * Every ingest path queries this one object: the FIRMS Area API, the EUMETSAT/SLSTR
 * search extent, the crop applied to full-disk GEO products and the EFFIS request
 * extents. It is not a literal at a call site, because a fire straddling the *query*
 * edge returns only the pixels inside the box — and then the hull, the centroid and the
 * FRP aggregate are all wrong, the miss-evidence accumulator counts overpasses that
 * "should have seen" pixels nobody ever asked for, and one fire can acquire two
 * identities on opposite sides of the edge.
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';

export interface BoundingBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * The buffer the bbox must keep around the alertable area, in kilometres:
 * `2 × ε_max + max watch-zone radius` = 2×6 + 30 (DATA-SOURCES §A9). Two epsilons,
 * because two detections of one fire are always within one ε of a chain member, so a
 * narrower band could let the query edge bisect a cluster.
 */
export const MIN_BBOX_BUFFER_KM = 2 * 6 + 30;

export const POLLING_BBOX: VersionedConfig<BoundingBox> = defineConfig(
  'polling_bbox',
  'polling_bbox_v1',
  { west: 20.0, south: 39.0, east: 31.0, north: 46.0 } as const,
);

/**
 * `west,south,east,north` — the FIRMS Area API argument order, which is *not* the order
 * most GIS tools print a bbox in. Rendered from the config rather than stored as a
 * string so the two can never drift apart.
 */
export function firmsAreaArgument(bbox: BoundingBox = POLLING_BBOX.values): string {
  assertBoundingBox(bbox);
  return [bbox.west, bbox.south, bbox.east, bbox.north].map(formatDegrees).join(',');
}

/**
 * Degrees are snapped to 1e-6 (~0.1 m) before rendering. That is what keeps the text out
 * of exponent notation — `String(1e-7)` is `"1e-7"`, which is not a coordinate any API
 * will accept, while the smallest magnitude that survives the snap renders as
 * `"0.000001"`. The poll run records this exact string.
 */
function formatDegrees(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

export function assertBoundingBox(bbox: BoundingBox): void {
  for (const [name, value] of Object.entries(bbox)) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`bbox.${name} must be a finite number, got ${String(value)}`);
    }
  }
  if (bbox.west >= bbox.east) {
    throw new RangeError(`bbox west (${bbox.west}) must be strictly west of east (${bbox.east})`);
  }
  if (bbox.south >= bbox.north) {
    throw new RangeError(
      `bbox south (${bbox.south}) must be strictly south of north (${bbox.north})`,
    );
  }
  if (bbox.south < -90 || bbox.north > 90) {
    throw new RangeError('bbox latitudes must lie within [-90, 90]');
  }
  if (bbox.west < -180 || bbox.east > 180) {
    throw new RangeError('bbox longitudes must lie within [-180, 180]');
  }
}

/** Kilometres per degree of latitude; the meridian is close enough to uniform for a buffer check. */
const KM_PER_DEGREE_LAT = 111.32;

/**
 * The land envelope of Bulgaria, to one thousandth of a degree. Not a border geometry —
 * the alertable *area* is a real polygon, and this is only the rectangle that bounds it,
 * which is what the §A9 buffer arithmetic is stated against.
 */
export const BULGARIA_ENVELOPE: BoundingBox = Object.freeze({
  west: 22.357,
  south: 41.235,
  east: 28.612,
  north: 44.215,
});

/** ANALYSIS.md: the alertable area is Bulgaria plus a 100 km cross-border band. */
export const ALERTABLE_BUFFER_KM = 100;

/**
 * Grows a box by `km` on every edge. Latitude first, because the longitudinal degree is
 * measured at the pole-most edge of the *result* — using the input's latitude would
 * understate the expansion by the width of the band itself.
 */
export function expandBboxKm(bbox: BoundingBox, km: number): BoundingBox {
  assertBoundingBox(bbox);
  const degreesLat = km / KM_PER_DEGREE_LAT;
  const south = bbox.south - degreesLat;
  const north = bbox.north + degreesLat;
  const worstLatitude = Math.min(Math.max(Math.abs(north), Math.abs(south)), 89);
  const degreesLon = km / (KM_PER_DEGREE_LAT * Math.cos((worstLatitude * Math.PI) / 180));
  return Object.freeze({
    west: bbox.west - degreesLon,
    south,
    east: bbox.east + degreesLon,
    north,
  });
}

/** Bulgaria + 100 km — the area the poll must contain with the §A9 buffer to spare. */
export function alertableEnvelope(): BoundingBox {
  return expandBboxKm(BULGARIA_ENVELOPE, ALERTABLE_BUFFER_KM);
}

/**
 * Does `bbox` clear `inner` by at least `MIN_BBOX_BUFFER_KM` on every edge?
 *
 * The longitudinal margin is measured at the latitude where a degree of longitude is
 * shortest *within the box* — the pole-most edge — because that is where a given number
 * of degrees buys the fewest kilometres.
 */
export function bboxBufferKm(
  bbox: BoundingBox,
  inner: BoundingBox,
): {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
} {
  assertBoundingBox(bbox);
  assertBoundingBox(inner);
  const worstLatitude = Math.max(Math.abs(inner.north), Math.abs(inner.south));
  const kmPerDegreeLon = KM_PER_DEGREE_LAT * Math.cos((worstLatitude * Math.PI) / 180);
  return {
    west: (inner.west - bbox.west) * kmPerDegreeLon,
    east: (bbox.east - inner.east) * kmPerDegreeLon,
    south: (inner.south - bbox.south) * KM_PER_DEGREE_LAT,
    north: (bbox.north - inner.north) * KM_PER_DEGREE_LAT,
  };
}

/**
 * The §A9 rule as an assertion. Called by the test that guards the config and by any
 * future code that widens the alertable area — widening the alerts without widening the
 * poll is the failure this exists to make loud.
 */
export function assertBboxCovers(bbox: BoundingBox, alertable: BoundingBox): void {
  const margin = bboxBufferKm(bbox, alertable);
  for (const [edge, km] of Object.entries(margin)) {
    if (km < MIN_BBOX_BUFFER_KM) {
      throw new RangeError(
        `polling bbox clears the alertable area by only ${km.toFixed(1)} km on the ${edge} ` +
          `edge; DATA-SOURCES §A9 requires at least ${MIN_BBOX_BUFFER_KM} km ` +
          '(2 × ε_max + max watch-zone radius)',
      );
    }
  }
}
