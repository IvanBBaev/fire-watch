/**
 * Geographic bounds arithmetic — the seam between "what the camera shows" and "what the
 * list says". The map layer owns MapLibre and reports its extent through these shapes;
 * `ui/` filters against them. Pure and DOM-free, so both sides can be tested without a
 * map instance (ADR-005 D1).
 */

/** A west/south/east/north box in degrees, the order every bbox in this repo uses. */
export interface GeoBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** Where the camera is pointed, with no statement about how much it can see from there. */
export interface MapCamera {
  readonly zoom: number;
  readonly lat: number;
  readonly lon: number;
}

/**
 * What the camera currently shows: its extent, the zoom that produced it, and its centre.
 * The centre travels with the extent because both consumers need it — the list sorts by
 * distance from it, and the camera-persistence key stores it.
 */
export interface MapViewport extends GeoBounds, MapCamera {}

/**
 * Does a point fall inside the box?
 *
 * The longitude test handles a box that crosses the antimeridian (`west > east`, which
 * MapLibre reports after a pan across ±180°) by accepting either side of the seam. Our
 * covered area never goes near it, but a viewport does whenever the user spins the globe,
 * and a naive `west <= lon && lon <= east` silently empties the list there.
 */
export function boundsContain(bounds: GeoBounds, lon: number, lat: number): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (lat < bounds.south || lat > bounds.north) return false;
  return bounds.west <= bounds.east
    ? lon >= bounds.west && lon <= bounds.east
    : lon >= bounds.west || lon <= bounds.east;
}

/** Kilometres per degree of latitude — the meridian is uniform enough for a buffer. */
const KM_PER_DEGREE_LAT = 111.32;

/**
 * Grow a box by `km` on every edge. Mirrors `server/src/core/config/polling-bbox.ts`
 * `expandBboxKm`, including its choice to measure the longitudinal degree at the
 * pole-most edge of the *result*: using the input's latitude understates the expansion by
 * the width of the band itself.
 */
export function expandBoundsKm(bounds: GeoBounds, km: number): GeoBounds {
  const degreesLat = km / KM_PER_DEGREE_LAT;
  const south = bounds.south - degreesLat;
  const north = bounds.north + degreesLat;
  const worstLatitude = Math.min(Math.max(Math.abs(north), Math.abs(south)), 89);
  const degreesLon = km / (KM_PER_DEGREE_LAT * Math.cos((worstLatitude * Math.PI) / 180));
  return Object.freeze({
    west: bounds.west - degreesLon,
    south,
    east: bounds.east + degreesLon,
    north,
  });
}
