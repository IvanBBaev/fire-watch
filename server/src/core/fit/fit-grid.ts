/**
 * The parameter grid a clustering fit sweeps (TASKS D7; review 11 §4.3–4.4; ADR-002 D5).
 *
 * Config-as-data: the axes are a versioned value, and the report cites its digest, so
 * "the fit swept the usual grid" is a checkable statement.
 *
 * Shape. 11 §4.3 stages the sweep (ε_viirs × T_LINK first, then ε_modis with VIIRS held)
 * and counts "~600 runs". This grid sweeps ε_viirs × ε_modis × T_LINK *jointly* instead —
 * the staging was a compute economy, and a joint grid lets the plateau rule see MODIS and
 * VIIRS interact (a wide MODIS ε can bridge two VIIRS clusters a narrow VIIRS ε kept
 * apart). The count lands on the same number: 150 configurations × the 4 fit seasons is
 * 600 season-runs.
 *
 * ε_modis has two slices that cannot share an axis. The fixed slice sweeps a constant ε;
 * the footprint slice keeps v1's rule `max(3, 1.5·√(scan·track))`, which is not a point
 * on the fixed axis (it varies per row with off-nadir scan growth). Each slice is its own
 * index space and the plateau rule finds regions within a slice, never across.
 *
 * Active window. The engine evicts a cluster `activeWindowHours` after its last
 * detection, so with T_LINK > window the T_LINK axis would be silently truncated. Each
 * cell therefore runs at `max(activeWindowFloorHours, T_LINK)`.
 *
 * ε_geo is not on the grid: it is fitted separately on 2025 under the exemption in 11
 * §9.1 (the SEVIRI/FCI record before 2025 is not the instrument in service), with the
 * selected config as its base. Its axis lives here so it is cited under the same digest.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { ClusteringParams, EpsRule } from '../clustering/clustering-params.js';
import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';

export interface FitGridAxes {
  readonly epsViirsKm: readonly number[];
  readonly epsModisFixedKm: readonly number[];
  readonly tLinkHours: readonly number[];
  readonly activeWindowFloorHours: number;
  readonly epsGeoKm: readonly number[];
}

export const FIT_GRID: VersionedConfig<FitGridAxes> = defineConfig(
  'clustering_fit_grid',
  'clustering_fit_grid_v1',
  {
    // ADR-002 D2 states 1.0–1.5 km; the axis brackets it by a step on each side so the
    // band's edges are interior points a plateau can be centred on.
    epsViirsKm: [0.75, 1, 1.25, 1.5, 2, 2.5],
    epsModisFixedKm: [2, 3, 4, 5],
    // ADR-002 D2 expects 36–60 h; 24 and 120 are the outer probes 11 §4.3 asks for.
    tLinkHours: [24, 36, 48, 72, 120],
    activeWindowFloorHours: 72,
    epsGeoKm: [3, 4, 5, 6, 8],
  } as const,
);

export type GridSlice = 'modis_fixed' | 'modis_footprint';

export interface GridCell {
  /** `modis_fixed/v1.25/m3/t48`, `modis_footprint/v1.25/t48` — stable, human-readable. */
  readonly id: string;
  readonly slice: GridSlice;
  /**
   * Position along each swept axis of the slice: `[viirs, modis, tLink]` for the fixed
   * slice, `[viirs, tLink]` for the footprint slice. Neighbourhood is ±1 on one index.
   */
  readonly index: readonly number[];
  readonly epsViirsKm: number;
  /** `null` in the footprint slice: the baseline footprint rule applies. */
  readonly epsModisKm: number | null;
  readonly tLinkHours: number;
}

const VIIRS_SOURCES: readonly SourceId[] = [
  'firms:viirs:snpp',
  'firms:viirs:noaa20',
  'firms:viirs:noaa21',
];

const GEO_SOURCES: readonly SourceId[] = ['lsasaf:seviri:frp-pixel', 'lsasaf:fci:frp-pixel'];

/** Every cell, fixed slice first, each slice in index order. */
export function gridCells(axes: FitGridAxes = FIT_GRID.values): readonly GridCell[] {
  const cells: GridCell[] = [];
  axes.epsViirsKm.forEach((viirs, iv) => {
    axes.epsModisFixedKm.forEach((modis, im) => {
      axes.tLinkHours.forEach((tLink, it) => {
        cells.push({
          id: `modis_fixed/v${String(viirs)}/m${String(modis)}/t${String(tLink)}`,
          slice: 'modis_fixed',
          index: [iv, im, it],
          epsViirsKm: viirs,
          epsModisKm: modis,
          tLinkHours: tLink,
        });
      });
    });
  });
  axes.epsViirsKm.forEach((viirs, iv) => {
    axes.tLinkHours.forEach((tLink, it) => {
      cells.push({
        id: `modis_footprint/v${String(viirs)}/t${String(tLink)}`,
        slice: 'modis_footprint',
        index: [iv, it],
        epsViirsKm: viirs,
        epsModisKm: null,
        tLinkHours: tLink,
      });
    });
  });
  return cells;
}

/** The dimension sizes of a slice, in index order. */
export function sliceShape(slice: GridSlice, axes: FitGridAxes = FIT_GRID.values): number[] {
  return slice === 'modis_fixed'
    ? [axes.epsViirsKm.length, axes.epsModisFixedKm.length, axes.tLinkHours.length]
    : [axes.epsViirsKm.length, axes.tLinkHours.length];
}

/** The clustering parameters a cell runs under: the base with the swept values replaced. */
export function cellParams(
  cell: GridCell,
  base: ClusteringParams,
  axes: FitGridAxes = FIT_GRID.values,
): ClusteringParams {
  const epsBySource: Record<SourceId, EpsRule> = { ...base.epsBySource };
  for (const source of VIIRS_SOURCES) epsBySource[source] = { kind: 'fixed', km: cell.epsViirsKm };
  if (cell.epsModisKm !== null) {
    epsBySource['firms:modis'] = { kind: 'fixed', km: cell.epsModisKm };
  }
  return {
    ...base,
    epsBySource,
    tLinkHours: cell.tLinkHours,
    activeWindowHours: Math.max(axes.activeWindowFloorHours, cell.tLinkHours),
  };
}

/** The base with every GEO source at `epsGeoKm` — the ε_geo sweep (11 §9.1 exemption). */
export function geoParams(epsGeoKm: number, base: ClusteringParams): ClusteringParams {
  const epsBySource: Record<SourceId, EpsRule> = { ...base.epsBySource };
  for (const source of GEO_SOURCES) epsBySource[source] = { kind: 'fixed', km: epsGeoKm };
  return { ...base, epsBySource };
}

/** Version of a grid cell's config. Distinct from `clustering_params_v*`: never deployable. */
export const FIT_CELL_CONFIG_VERSION = 'clustering_params_fit_cell_v1';

/** A cell's parameters as a versioned config, so the report can cite its digest. */
export function cellConfig(params: ClusteringParams): VersionedConfig<ClusteringParams> {
  return defineConfig('clustering_params', FIT_CELL_CONFIG_VERSION, params);
}
