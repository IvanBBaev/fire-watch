/**
 * Great-circle distance and compass bearing between two WGS84 points — pure, no I/O.
 *
 * Used only to say, in words, roughly where an event lies relative to the reader
 * ("about 12 km NE of your location"). It is informational context, never a route: no
 * drive-time, no directions and no road snapping (GLOSSARY §5.2 "No routing, ever").
 */

/** Mean Earth radius (IUGG), in kilometres. */
const EARTH_RADIUS_KM = 6371.0088;

export interface LonLat {
  readonly lon: number;
  readonly lat: number;
}

/** The eight compass points, clockwise from north. */
export const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/** Haversine distance in kilometres. */
export function distanceKm(from: LonLat, to: LonLat): number {
  const phi1 = toRadians(from.lat);
  const phi2 = toRadians(to.lat);
  const dPhi = phi2 - phi1;
  const dLambda = toRadians(to.lon - from.lon);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing from `from` to `to`, in degrees clockwise from north [0, 360). */
export function initialBearingDegrees(from: LonLat, to: LonLat): number {
  const phi1 = toRadians(from.lat);
  const phi2 = toRadians(to.lat);
  const dLambda = toRadians(to.lon - from.lon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const degrees = toDegrees(Math.atan2(y, x));
  return ((degrees % 360) + 360) % 360;
}

/** Snaps a bearing to the nearest of the eight compass points (each owns a 45° sector). */
export function compassPoint(bearingDegrees: number): CompassPoint {
  const normalised = ((bearingDegrees % 360) + 360) % 360;
  const index = Math.round(normalised / 45) % COMPASS_POINTS.length;
  return COMPASS_POINTS[index] ?? 'N';
}

export interface RelativePosition {
  /** Rounded for display: whole km at 10 km and beyond, one decimal below, never below 0.1. */
  readonly km: number;
  readonly compass: CompassPoint;
  /** Under this distance a direction is noise against the event's own spread. */
  readonly nearby: boolean;
}

/** Below this, a bearing says nothing a satellite cluster can support. */
export const NEARBY_THRESHOLD_KM = 1;

/** Where `target` lies as seen from `origin`, rounded for a sentence. */
export function relativePosition(origin: LonLat, target: LonLat): RelativePosition {
  const km = distanceKm(origin, target);
  const rounded = km >= 10 ? Math.round(km) : Math.max(0.1, Math.round(km * 10) / 10);
  return {
    km: rounded,
    compass: compassPoint(initialBearingDegrees(origin, target)),
    nearby: km < NEARBY_THRESHOLD_KM,
  };
}
