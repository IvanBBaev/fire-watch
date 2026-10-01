/**
 * `wind_overlay_v1` — how the F14 wind context layer is cut from the recorded ECMWF
 * fields (TASKS F14; DATA-SOURCES §D2).
 *
 * The layer is context, not analysis: a reader glancing at a fire wants "which way is
 * the smoke going, and is it windy" — not a forecast product. So the grid is coarse on
 * purpose. 0.5° over the polling bbox is 23 × 15 = 345 arrows, one every ~40–55 km,
 * which reads as a field at country zoom and costs a few kilobytes of JSON. The IFS grid
 * is 0.25°, so every 0.5° point is an exact grid point: nothing is interpolated, and
 * each arrow is a value ECMWF published, not one we made up between two.
 *
 * `maxStepDistanceHours` is the honesty bound on the read route: the arrows are served
 * for the recorded step nearest "now", and when even the nearest one is further away
 * than this the route answers "no current wind" instead of drawing yesterday's wind on
 * today's map. With steps 6 h apart a fresh run is always within 3 h; 6 h allows one
 * missed run before the layer goes dark.
 */

import { POLLING_BBOX, type BoundingBox } from './polling-bbox.js';
import { defineConfig, type VersionedConfig } from './versioned-config.js';

export interface WindOverlayValues {
  readonly bbox: BoundingBox;
  readonly resolutionDeg: number;
  readonly maxStepDistanceHours: number;
}

export const WIND_OVERLAY: VersionedConfig<WindOverlayValues> = defineConfig(
  'wind_overlay',
  'wind_overlay_v1',
  {
    bbox: POLLING_BBOX.values,
    resolutionDeg: 0.5,
    maxStepDistanceHours: 6,
  } as const,
);
