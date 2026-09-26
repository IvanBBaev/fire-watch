/**
 * Pixel-footprint geometry — the cell a satellite actually integrated over, not the point
 * we draw it at.
 *
 * A detection is published as a pixel *centre*, but the observation covers a whole cell:
 * VIIRS stays near 375 m across the swath, MODIS grows to roughly 4.8 km at scan edge
 * (`server/src/core/ingest/detection-validation.ts`). Rendering only the centre is the
 * overconfidence DATA-SOURCES §52 names outright, and GLOSSARY §5.2 already decides
 * against it: *"past roughly 1:25k the surface switches to the detection footprint rather
 * than sharpening a point that would read as 'go here'"*. This module is that switch.
 *
 * **What the cell claims.** That somewhere inside it the instrument measured heat — not
 * that the whole cell is burning, and not where inside it the fire sits. That is exactly
 * the honest statement, and it is why the fill is hatched rather than solid: a solid
 * polygon reads as a surveyed perimeter, which we never have.
 *
 * **The axis simplification.** `scan` is the across-track extent and `track` the
 * along-track one; their true orientation follows the satellite's heading, which the FIRMS
 * CSV does not carry. We map scan→east-west and track→north-south and draw an
 * axis-aligned cell. At these sizes the error is a rotation of a box whose area is right,
 * which is well inside what a hatched "somewhere in here" is claiming.
 */

import type { GeoBounds } from './viewport.js';

/**
 * The pinned nadir footprint, substituted when a row carries no usable `scan`/`track`
 * (ADR-002 Appendix A rule 4, review 14 M5).
 *
 * The authority is `server/src/core/ingest/detection-validation.ts`
 * (`NADIR_SCAN_KM`/`NADIR_TRACK_KM`); the web package cannot import across that boundary,
 * so the numbers are transcribed here and `footprint.test.ts` pins them — the same
 * arrangement `coverage.ts` uses for the polling bbox. 1.0 × 2.0 km is the *coarse*
 * choice on purpose: a cell drawn larger than the truth overstates uncertainty, which is
 * the safe direction to be wrong in.
 */
export const NADIR_SCAN_KM = 1.0;
export const NADIR_TRACK_KM = 2.0;

/**
 * The plausible envelope, in kilometres — mirrors the ingest-side `MAX_FOOTPRINT_KM`.
 * A value outside it is a unit change or a shifted column, never a measurement, and the
 * renderer falls back rather than painting a cell the size of a province.
 */
const MAX_FOOTPRINT_KM = 10;

/** Kilometres per degree of latitude; the meridian is uniform enough at this precision. */
const KM_PER_DEGREE_LAT = 111.32;

export interface FootprintKm {
  readonly scanKm: number;
  readonly trackKm: number;
}

/** A closed GeoJSON linear ring: `[lon, lat]` pairs, first point repeated last. */
export type LinearRing = ReadonlyArray<readonly [number, number]>;

function isUsable(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0 && value <= MAX_FOOTPRINT_KM;
}

/**
 * Resolve the cell size to draw, applying the nadir default.
 *
 * The substitution replaces the *pair*, never the broken axis alone — the same rule the
 * clustering ε follows (`server/src/core/clustering/eps.ts`). Mixing a real scan with a
 * defaulted track would invent an aspect ratio no instrument produced.
 */
export function resolveFootprintKm(scanKm: number | null, trackKm: number | null): FootprintKm {
  if (isUsable(scanKm) && isUsable(trackKm)) return { scanKm, trackKm };
  return { scanKm: NADIR_SCAN_KM, trackKm: NADIR_TRACK_KM };
}

/**
 * The cell as a west/south/east/north box around a pixel centre.
 *
 * The longitudinal degree is measured at the centre's own latitude: a cell is small enough
 * that the convergence across it is far below the footprint uncertainty itself. `cos` is
 * floored so a pathological latitude yields a wide box rather than an infinite one.
 */
export function footprintBounds(lon: number, lat: number, footprint: FootprintKm): GeoBounds {
  const halfLat = footprint.trackKm / 2 / KM_PER_DEGREE_LAT;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const halfLon = footprint.scanKm / 2 / (KM_PER_DEGREE_LAT * cosLat);
  return {
    west: lon - halfLon,
    south: lat - halfLat,
    east: lon + halfLon,
    north: lat + halfLat,
  };
}

/**
 * The cell as a closed ring, wound counter-clockwise per RFC 7946 for an exterior ring.
 * MapLibre tolerates either winding, but a well-formed ring is what makes these features
 * safe to hand to anything else later — an export, a share card, a server-side render.
 */
export function footprintRing(lon: number, lat: number, footprint: FootprintKm): LinearRing {
  const { west, south, east, north } = footprintBounds(lon, lat, footprint);
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}
