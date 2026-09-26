/**
 * What "covered" means on the client — the same geometry the ingest side polls, restated
 * for the browser.
 *
 * The authority is `server/src/core/config/polling-bbox.ts`; the web package cannot import
 * across that boundary, so the numbers are transcribed here and `coverage.test.ts` pins
 * them. Two distinct areas, and conflating them misleads the reader:
 *
 * - {@link POLLING_AREA} is what we *ask the satellites for* — a wide Balkan box, so a fire
 *   just past the border is already in hand when it matters.
 * - {@link COVERED_AREA} is what we *stand behind*: Bulgaria plus a 100 km cross-border
 *   band. Outside it we still show whatever the poll returned, but we make no claim of
 *   watching it, which is what the copy in `mapControls.coverageNote` says out loud.
 */

import type { GeoBounds } from './viewport.js';
import { boundsContain, expandBoundsKm } from './viewport.js';

/** Bulgaria's bounding envelope (the country, not the coverage promise). */
export const BULGARIA_ENVELOPE: GeoBounds = Object.freeze({
  west: 22.357,
  south: 41.235,
  east: 28.612,
  north: 44.215,
});

/** The cross-border band we stand behind — fires do not stop at the border. */
export const COVERAGE_BUFFER_KM = 100;

/** Bulgaria + {@link COVERAGE_BUFFER_KM}: the area the product claims to watch. */
export const COVERED_AREA: GeoBounds = expandBoundsKm(BULGARIA_ENVELOPE, COVERAGE_BUFFER_KM);

/** The wider box the ingest side actually polls (FIRMS `area`), for context in the UI. */
export const POLLING_AREA: GeoBounds = Object.freeze({
  west: 20.0,
  south: 39.0,
  east: 31.0,
  north: 46.0,
});

/**
 * Is this point somewhere we claim to watch? Used to decide whether a geolocation fix may
 * take the camera: dropping a user in Lisbon onto an empty map reads as "no fires here",
 * which is exactly the claim the product must never make (GLOSSARY §5 rule 4).
 */
export function isInsideCoverage(lon: number, lat: number): boolean {
  return boundsContain(COVERED_AREA, lon, lat);
}
