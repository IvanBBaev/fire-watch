/**
 * `fire_outline_params_v1` — how an estimated outline is drawn from an event's own
 * VIIRS/MODIS detections (V2-A4).
 *
 * **An estimate, never a perimeter.** The outline is the union of the pixel footprints the
 * satellites flagged, joined across gaps narrower than `closingKm`. A pixel is flagged when
 * part of it is hot enough, not when all of it burns, and a burned pixel the satellite did
 * not see (cloud, smoke, no overpass) is simply missing. The copy says both; nothing here
 * is an official perimeter and nothing here predicts spread.
 *
 * Versioned for the same reason the clustering params are: two runs that claim the same
 * version must draw the same outline byte for byte, and each stored outline records the
 * version it was drawn under, so a retune recomputes every row instead of mixing two rules
 * on one map.
 *
 * Founder decisions (judgement, not a published number):
 *   - `closingKm` 0.375 — one VIIRS pixel. Two footprints with a gap of up to two pixels
 *     between them are drawn as one shape; a wider gap stays two shapes.
 *   - `cellKm` 0.05 — a raster seven to eight cells across one VIIRS pixel, small enough
 *     that the raster's own staircase is well inside the pixel's position uncertainty.
 *   - SLSTR and the geostationary sources are left out: their pixels (1 km and 3–5 km) are
 *     coarser than the fire most of the time, and an outline drawn from them would be a
 *     picture of the instrument, not of the burn.
 */

import type { LiveSourceId } from '@fire-watch/contracts';

import { CLUSTERING_PARAMS, type PlanarMetric } from '../clustering/clustering-params.js';
import { defineConfig, type VersionedConfig } from './versioned-config.js';

/** The nominal footprint a source's pixel is drawn with when the row carries none. */
export interface OutlineFootprint {
  readonly defaultScanKm: number;
  readonly defaultTrackKm: number;
}

export interface FireOutlineValues {
  /**
   * Which sources draw an outline, keyed by every registry id so adding a source without
   * deciding whether it draws is a type error. `null` leaves the source out.
   */
  readonly footprintBySource: Readonly<Record<LiveSourceId, OutlineFootprint | null>>;
  /** Morphological closing radius: footprints closer than twice this join into one shape. */
  readonly closingKm: number;
  /** The raster's cell edge. Doubled until the grid fits {@link maxGridCells}. */
  readonly cellKm: number;
  readonly maxGridCells: number;
  /** Detections an outline is drawn from; the newest are kept when an event has more. */
  readonly maxDetections: number;
  /** A ring with more vertices is simplified, its tolerance doubled from one cell until it fits. */
  readonly maxVerticesPerRing: number;
  /** Polygons kept per outline, largest first. The area still counts every shape. */
  readonly maxPolygons: number;
  /** Events drawn per pass; the rest wait for the next one. */
  readonly batchSize: number;
  /** The plane the footprints are laid on — the identity engine's, so both agree on distance. */
  readonly metric: PlanarMetric;
}

export const FIRE_OUTLINE_PARAMS: VersionedConfig<FireOutlineValues> = defineConfig(
  'fire_outline_params',
  'fire_outline_params_v1',
  {
    footprintBySource: {
      // VIIRS I-band: 375 m at nadir, growing to about 0.8 × 0.8 km at the swath edge; the
      // row's own scan/track is used when it carries one.
      'firms:viirs:snpp': { defaultScanKm: 0.375, defaultTrackKm: 0.375 },
      'firms:viirs:noaa20': { defaultScanKm: 0.375, defaultTrackKm: 0.375 },
      'firms:viirs:noaa21': { defaultScanKm: 0.375, defaultTrackKm: 0.375 },
      // MODIS: 1 km at nadir, up to about 4.8 × 2 km at the swath edge.
      'firms:modis': { defaultScanKm: 1.0, defaultTrackKm: 1.0 },
      'eumetsat:slstr:frp': null,
      'lsasaf:seviri:frp-pixel': null,
      'lsasaf:fci:frp-pixel': null,
    },
    closingKm: 0.375,
    cellKm: 0.05,
    maxGridCells: 2_000_000,
    maxDetections: 5000,
    maxVerticesPerRing: 256,
    maxPolygons: 32,
    batchSize: 100,
    metric: CLUSTERING_PARAMS.values.metric,
  } as const,
);
