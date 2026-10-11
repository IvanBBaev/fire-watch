import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { cellParams, geoParams, gridCells, sliceShape } from './fit-grid.js';
import { FIT_PARAMS } from './fit-params.js';

describe('fit grid (11 §4.5)', () => {
  const cells = gridCells();

  it('has 150 cells — 600 runs over the four fit seasons', () => {
    expect(cells).toHaveLength(150);
    expect(cells.filter((c) => c.slice === 'modis_fixed')).toHaveLength(120);
    expect(sliceShape('modis_fixed')).toEqual([6, 4, 5]);
    expect(sliceShape('modis_footprint')).toEqual([6, 5]);
    expect(cells.length * FIT_PARAMS.values.splits.fit.length).toBe(600);
    expect(new Set(cells.map((c) => c.id)).size).toBe(150);
  });

  it('names cells by their values and indexes them by position', () => {
    expect(cells[0]).toMatchObject({ id: 'modis_fixed/v0.75/m2/t24', index: [0, 0, 0] });
    expect(cells.find((c) => c.id === 'modis_footprint/v1.25/t48')?.index).toEqual([2, 2]);
  });

  it('replaces only the swept values, with the active window floored at 72 h', () => {
    const base = CLUSTERING_PARAMS.values;
    const fixed = cells.find((c) => c.id === 'modis_fixed/v2/m4/t120');
    const footprint = cells.find((c) => c.id === 'modis_footprint/v0.75/t24');
    if (fixed === undefined || footprint === undefined) throw new Error('missing cell');
    const p = cellParams(fixed, base);
    expect(p.epsBySource['firms:viirs:snpp']).toEqual({ kind: 'fixed', km: 2 });
    expect(p.epsBySource['firms:viirs:noaa20']).toEqual({ kind: 'fixed', km: 2 });
    expect(p.epsBySource['firms:modis']).toEqual({ kind: 'fixed', km: 4 });
    expect(p.tLinkHours).toBe(120);
    expect(p.activeWindowHours).toBe(120);
    const q = cellParams(footprint, base);
    expect(q.epsBySource['firms:modis']).toEqual(base.epsBySource['firms:modis']);
    expect(q.tLinkHours).toBe(24);
    expect(q.activeWindowHours).toBe(72);
    expect(q.epsBySource['lsasaf:seviri:frp-pixel']).toEqual(
      base.epsBySource['lsasaf:seviri:frp-pixel'],
    );
  });

  it('sweeps ε_geo on the GEO sources only', () => {
    const base = CLUSTERING_PARAMS.values;
    const p = geoParams(8, base);
    expect(p.epsBySource['lsasaf:fci:frp-pixel']).toEqual({ kind: 'fixed', km: 8 });
    expect(p.epsBySource['lsasaf:seviri:frp-pixel']).toEqual({ kind: 'fixed', km: 8 });
    expect(p.epsBySource['firms:viirs:snpp']).toEqual(base.epsBySource['firms:viirs:snpp']);
  });
});
