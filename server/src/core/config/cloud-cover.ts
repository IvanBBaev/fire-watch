/**
 * `cloud_cover_v1` — how the F17 per-pass cloud forecast is recorded, cut and sampled
 * (TASKS F17; DATA-SOURCES §D2).
 *
 * A satellite pass over a cell only sees a fire if the sky between them is clear, so the
 * passes panel says, per pass, how cloudy ECMWF's IFS *forecast* the cell to be at the
 * pass's culmination. It is a forecast, never an observation, and the document says so.
 *
 * **Steps.** `weather_context_v1` records `tcc` at steps 0/6/12 of the latest run — not
 * enough for a pass window that reaches a day ahead. The latest safely published run is
 * 8–14 h old (`publicationDelayHours` 8, a run every 6 h) and the window ends 24 h (plus
 * one 10-minute bucket) after now, so the furthest culmination is at most ~38.2 h after
 * the run: steps 0–39 every 3 h cover it, 3-hourly being the finest the open IFS data
 * publishes. `weather_context_v1` itself is frozen (review 23 E6: a bump opens DS-2.1),
 * so the extra steps are recorded under *this* config, `tcc` only, by the same refresh.
 *
 * **The start of the window.** It reaches 12 h back, which can precede the latest run by
 * up to 4 h. `previousRunSteps` names the earlier run's steps the derivation merges in for
 * that gap: the previous run was the latest six hours earlier and was recorded then, so
 * nothing extra is fetched. For any valid time both runs cover, the newer run wins.
 *
 * **Sampling.** Values are read at the 0.5° pass-cell centres over the polling bbox —
 * each an exact IFS 0.25° grid point, so nothing is interpolated in space. In time the
 * value at a culmination is **linear between the two recorded steps that bracket it**
 * (exact when it falls on a step), and only when those steps are at most
 * `maxBracketHours` apart: one missing step is bridged, a longer hole answers "no
 * forecast" rather than drawing a line across half a day of weather. Outside the
 * recorded steps the answer is also "no forecast" — never an extrapolation.
 *
 * **Units.** ECMWF's `tcc` is a 0–1 fraction packed in 8 bits (a resolution of 1/128,
 * ~0.8 %). Stored and served as whole percent, which is all that resolution supports.
 */

import { POLLING_BBOX, type BoundingBox } from './polling-bbox.js';
import { defineConfig, type VersionedConfig } from './versioned-config.js';

export interface CloudCoverValues {
  /** The ECMWF short name recorded and read. */
  readonly param: string;
  /** Steps of the latest run to record and read (hours from the run). */
  readonly steps: readonly number[];
  /** Steps of the run before it, merged in for the part of the window before the latest run. */
  readonly previousRunSteps: readonly number[];
  readonly bbox: BoundingBox;
  /** Cell size of the sampling grid; points sit at cell centres (`west + size / 2`, …). */
  readonly cellDeg: number;
  /** The widest gap between two bracketing steps that is still interpolated across. */
  readonly maxBracketHours: number;
}

export const CLOUD_COVER: VersionedConfig<CloudCoverValues> = defineConfig(
  'cloud_cover',
  'cloud_cover_v1',
  {
    param: 'tcc',
    steps: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39],
    previousRunSteps: [0, 3],
    bbox: POLLING_BBOX.values,
    cellDeg: 0.5,
    maxBracketHours: 6,
  } as const,
);
