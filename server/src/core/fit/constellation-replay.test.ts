import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { defineConfig } from '../config/versioned-config.js';
import { CONSTELLATION_2027, type Constellation } from './constellation.js';
import { judgeConstellation, runConstellationReplay } from './constellation-replay.js';
import { FIT_GRID } from './fit-grid.js';
import type { Verdict } from './fit-metrics.js';
import { FIT_PARAMS } from './fit-params.js';
import type { SplitResult } from './fit-run.js';

function split(pass: boolean, seasons: number[] = [2020]): SplitResult {
  const verdict: Verdict = {
    pass,
    views: [
      {
        view: 'all|pooled',
        pass,
        checks: [
          { metric: 'pairwise_recall', target: '>= 0.95', met: pass },
          { metric: 'chimera_rate', target: '<= 0.03', met: pass ? true : null },
        ],
      },
    ],
  };
  return { seasons, eventCount: 1, verdict, views: [] };
}

describe('judgeConstellation (GATES L-14 verdict)', () => {
  it('passes when every split meets the thresholds and every live source was measured', () => {
    expect(judgeConstellation({ fit: split(true), calibrate: split(true) }, [])).toEqual({
      outcome: 'pass',
      refitRequired: false,
      reasons: [],
    });
  });

  it('fails and requires a re-fit on any threshold miss, naming missed and unmeasured checks', () => {
    const verdict = judgeConstellation({ fit: split(true), calibrate: split(false, [2024]) }, [
      'eumetsat:slstr:frp',
    ]);
    expect(verdict.outcome).toBe('fail');
    expect(verdict.refitRequired).toBe(true);
    expect(verdict.reasons).toEqual([
      'calibrate all|pooled pairwise_recall missed (target >= 0.95)',
      'calibrate all|pooled chimera_rate unmeasured (target <= 0.03)',
    ]);
  });

  it('is pass_unproven when a live source has no rows', () => {
    const verdict = judgeConstellation({ fit: split(true), calibrate: split(true) }, [
      'firms:viirs:noaa21',
    ]);
    expect(verdict.outcome).toBe('pass_unproven');
    expect(verdict.reasons).toEqual([
      'live sources with no archive rows, so no per-source metrics: firms:viirs:noaa21',
    ]);
  });

  it('is pass_unproven when one acceptance split has no data, and no_data when neither has', () => {
    expect(
      judgeConstellation(
        { fit: split(true), calibrate: { skipped: 'no calibrate-season data' } },
        [],
      ).outcome,
    ).toBe('pass_unproven');
    expect(
      judgeConstellation({ fit: { skipped: 'x' }, calibrate: { skipped: 'y' } }, []),
    ).toMatchObject({ outcome: 'no_data', refitRequired: false });
  });
});

describe('runConstellationReplay', () => {
  it('refuses a constellation inconsistent with the source registry before any clustering', () => {
    const broken = defineConfig<Constellation>('live_constellation', 'broken_v1', {
      ...CONSTELLATION_2027.values,
      membership: { ...CONSTELLATION_2027.values.membership, 'firms:modis': 'live' },
    });
    expect(() =>
      runConstellationReplay({
        detections: [],
        geoDetections: [],
        perimeters: [],
        constellation: broken,
        params: FIT_PARAMS,
        grid: FIT_GRID,
        incumbent: CLUSTERING_PARAMS,
        runEpsGeo: false,
      }),
    ).toThrow(/broken_v1 is inconsistent: firms:modis: retired/);
  });

  it('reports no_data on an empty stream', () => {
    const result = runConstellationReplay({
      detections: [],
      geoDetections: [],
      perimeters: [],
      constellation: CONSTELLATION_2027,
      params: FIT_PARAMS,
      grid: FIT_GRID,
      incumbent: CLUSTERING_PARAMS,
      runEpsGeo: false,
    });
    expect(result.verdict.outcome).toBe('no_data');
    expect(result.coverage.missing).toEqual([
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
      'eumetsat:slstr:frp',
    ]);
    expect(result.refit.test).toEqual({
      touched: false,
      reason: 'not requested (--touch-test-season)',
    });
  });
});
