/**
 * What a location fix means for the camera.
 *
 * "Open where the user is" is only useful inside the area this product actually watches
 * (Bulgaria plus the 100 km cross-border band — core/geo/coverage.ts). A fix in Lisbon
 * must not drop the user onto an empty map that looks like "no fires here": there are no
 * fires *shown* there because nothing is polled there, and the two read identically.
 *
 * Pure: the port produces the outcome, this decides what to do with it, and `ui/` only
 * renders the decision.
 */

import { isInsideCoverage } from './coverage.js';
import type { GeoFixOutcome } from '../ports.js';
import type { MapCamera } from './viewport.js';

/**
 * Zoom for "where I am": a region around the user rather than a rooftop. Fires are a
 * landscape-scale event, and a tighter zoom would frame a garden while a fire two valleys
 * away goes off-screen.
 */
export const LOCATED_ZOOM = 9;

export type LocateOutcome =
  /** Inside coverage — move the camera there. */
  | { readonly kind: 'moved'; readonly camera: MapCamera }
  /** A real fix, but outside what we watch: say so, and leave the camera where it is. */
  | { readonly kind: 'outsideCoverage' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' };

export function resolveLocateOutcome(outcome: GeoFixOutcome): LocateOutcome {
  switch (outcome.kind) {
    case 'denied':
      return { kind: 'denied' };
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'fix':
      return isInsideCoverage(outcome.lon, outcome.lat)
        ? { kind: 'moved', camera: { zoom: LOCATED_ZOOM, lat: outcome.lat, lon: outcome.lon } }
        : { kind: 'outsideCoverage' };
  }
}
