import { LIVE_SOURCE_IDS, SOURCE_REGISTRY } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import {
  CONSTELLATION_2027,
  CONSTELLATIONS,
  constellationByVersion,
  constellationProblems,
  restrictToConstellation,
  sourcesWithRole,
  type Constellation,
} from './constellation.js';
import type { FitDetection } from './label-join.js';

function row(uid: string, source: FitDetection['source']): FitDetection {
  return {
    detectionUid: uid,
    source,
    acqTsIso: '2024-07-10T12:00:00Z',
    latCanonical: '42.700000',
    lonCanonical: '23.000000',
    scanKm: null,
    trackKm: null,
  };
}

describe('the 2027 constellation (GATES L-14)', () => {
  it('flies NOAA-20/21 VIIRS and SLSTR, drops MODIS and S-NPP, keeps the GEO sources', () => {
    const c = CONSTELLATION_2027.values;
    expect(sourcesWithRole(c, 'live')).toEqual([
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
      'eumetsat:slstr:frp',
    ]);
    expect(sourcesWithRole(c, 'dropped')).toEqual(['firms:viirs:snpp', 'firms:modis']);
    expect(sourcesWithRole(c, 'attach_only')).toEqual([
      'lsasaf:seviri:frp-pixel',
      'lsasaf:fci:frp-pixel',
    ]);
  });

  it('every shipped constellation is consistent with the source registry', () => {
    for (const c of CONSTELLATIONS) expect(constellationProblems(c.values)).toEqual([]);
    for (const id of LIVE_SOURCE_IDS) {
      if (SOURCE_REGISTRY[id].status === 'retired') {
        expect(CONSTELLATION_2027.values.membership[id]).toBe('dropped');
      }
    }
  });

  it('is looked up by version', () => {
    expect(constellationByVersion('constellation_2027_v1')).toBe(CONSTELLATION_2027);
    expect(constellationByVersion('constellation_2028_v1')).toBeNull();
  });
});

describe('constellationProblems', () => {
  const base = CONSTELLATION_2027.values;
  const edit = (patch: Partial<Constellation>): Constellation => ({ ...base, ...patch });

  it('flags a GEO source made live, a retired source kept, and missing or stray reasons', () => {
    const problems = constellationProblems(
      edit({
        membership: {
          ...base.membership,
          'lsasaf:seviri:frp-pixel': 'live',
          'firms:modis': 'live',
          'firms:viirs:noaa20': 'dropped',
        },
      }),
    );
    expect(problems).toEqual([
      'firms:viirs:noaa20: dropped without a reason',
      'firms:modis: retired in the registry but live in the constellation',
      'firms:modis: has a drop reason but is live',
      'lsasaf:seviri:frp-pixel: role live disagrees with the registry (attachOnly true)',
    ]);
  });

  it('flags a constellation that could never create an event', () => {
    const membership = Object.fromEntries(
      LIVE_SOURCE_IDS.map((id) => [id, SOURCE_REGISTRY[id].attachOnly ? 'attach_only' : 'dropped']),
    ) as Constellation['membership'];
    const droppedBecause = Object.fromEntries(
      LIVE_SOURCE_IDS.filter((id) => membership[id] === 'dropped').map((id) => [id, 'test']),
    );
    expect(constellationProblems(edit({ membership, droppedBecause }))).toEqual([
      'no live source: the stream could never create an event',
    ]);
  });
});

describe('restrictToConstellation', () => {
  it('removes dropped-source rows, keeps everything else in order, and counts what it removed', () => {
    const rows = [
      row('1', 'firms:viirs:snpp'),
      row('2', 'firms:viirs:noaa20'),
      row('3', 'firms:modis'),
      row('4', 'lsasaf:seviri:frp-pixel'),
      row('5', 'firms:viirs:snpp'),
      row('6', 'eumetsat:slstr:frp'),
    ];
    const { kept, droppedRows } = restrictToConstellation(rows, CONSTELLATION_2027.values);
    expect(kept.map((d) => d.detectionUid)).toEqual(['2', '4', '6']);
    expect(droppedRows).toEqual({ 'firms:viirs:snpp': 2, 'firms:modis': 1 });
  });
});
