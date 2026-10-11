import type { SourceId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { NO_EVENT, type SeasonPartition } from './fit-clustering.js';
import {
  adjustedRand,
  allViews,
  evaluateSeason,
  poolEvaluations,
  verdictOf,
  viewKey,
  viewOf,
  type Tallies,
  type Tally,
} from './fit-metrics.js';
import { FIT_PARAMS } from './fit-params.js';
import type { FitDetection } from './label-join.js';
import { AMBIGUOUS, UNLABELED, type SeasonFrame } from './season-frame.js';

const H = 3_600_000;
const SNPP: SourceId = 'firms:viirs:snpp';
const MODIS: SourceId = 'firms:modis';
const SEVIRI: SourceId = 'lsasaf:seviri:frp-pixel';

function det(i: number, source: SourceId): FitDetection {
  return {
    detectionUid: `d${String(i)}`,
    source,
    acqTsIso: '2021-07-01T00:00:00Z',
    latCanonical: '42.700000',
    lonCanonical: '23.000000',
    scanKm: null,
    trackKm: null,
  };
}

/**
 * Hand-built season. Fires: A (30 ha, 10–50) = d0–d3, B (100 ha, 50–500) = d4–d6,
 * C (15 ha, 10–50) = d9 (a GEO row that attached nowhere). d7 unlabelled, d8 ambiguous.
 *
 *   event 10 = d0 d1 d2 (A) + d4 d5 (B)  ← a chimera
 *   event 11 = d3 (A, MODIS)             ← A is over-split into 2
 *   event 12 = d6 (B) + d7 (unlabelled)  ← B is over-split into 2
 *   event 13 = d8 (ambiguous)
 *   d9: no event
 *
 * Hard negatives (A is the smaller fire of each): (d0,d4) same event, (d2,d6) and
 * (d3,d6) separated; (d3,d6) is MODIS × VIIRS, i.e. cross-source.
 */
const SOURCES: SourceId[] = [SNPP, SNPP, SNPP, MODIS, SNPP, SNPP, SNPP, SNPP, SNPP, SEVIRI];
const HOURS = [0, 1, 2, 30, 20, 21, 40, 41, 50, 60];
const FRAME: SeasonFrame = {
  season: 2021,
  detections: SOURCES.map((s, i) => det(i, s)),
  acqMs: HOURS.map((h) => h * H),
  coordinates: SOURCES.map(() => ({ lat: 42.7, lon: 23 })),
  attachOnly: SOURCES.map((s) => s === SEVIRI),
  fireIndex: [0, 0, 0, 0, 1, 1, 1, UNLABELED, AMBIGUOUS, 2],
  fires: [
    { fireId: '2021/a', areaHa: 30, stratum: '10_50_ha', gated: true },
    { fireId: '2021/b', areaHa: 100, stratum: '50_500_ha', gated: true },
    { fireId: '2021/c', areaHa: 15, stratum: '10_50_ha', gated: true },
  ],
  hardNegatives: { a: [0, 2, 3], b: [4, 6, 6] },
  labels: { labeled: 8, ambiguous: 1, unlabeled: 1 },
  sources: [MODIS, SNPP, SEVIRI],
};
const PARTITION: SeasonPartition = {
  eventOf: [10, 10, 10, 11, 10, 10, 12, 12, 13, NO_EVENT],
  startedAt: new Map([
    [10, 0],
    [11, 30 * H],
    [12, 40 * H],
    [13, 50 * H],
  ]),
  eventCount: 4,
};

const evaluation = evaluateSeason(FRAME, PARTITION, FIT_PARAMS.values);
const view = (scope: string, stratum: string) =>
  viewOf(evaluation.tallies.get(viewKey(scope, stratum)));
const rate = (n: number, d: number) => ({ numerator: n, denominator: d, rate: n / d });

describe('evaluateSeason — hand-computed metrics', () => {
  it('scores the pooled (gated strata) view', () => {
    const v = view('all', 'pooled');
    // A: C(3,2)+C(1,2) = 3 of C(4,2) = 6; B: C(2,2) = 1 of 3; C: no pairs.
    expect(v.pairwiseRecall.numerator).toBe(4);
    expect(v.pairwiseRecall.denominator).toBe(9);
    // (d0,d4) share event 10; the other two are separated.
    expect(v.pairwisePrecision.numerator).toBe(2);
    expect(v.pairwisePrecision.denominator).toBe(3);
    // F1 = 2·(4/9)·(2/3) / (4/9 + 2/3) = 8/15.
    expect(v.pairwiseF1).toBeCloseTo(8 / 15, 12);
    // A holds ≥10 % in events 10 and 11, B in 10 and 12; C has no event.
    expect(v.overSplitMean).toBe(2);
    expect(v.overSplitP95.value).toBe(2);
    expect(v.firesWithoutEvent).toBe(1);
    // Event 10 is a chimera (A 3/5, B 2/5); 11 and 12 are not.
    expect(v.chimeraRate.numerator).toBe(1);
    expect(v.chimeraRate.denominator).toBe(3);
    // A: dominant event 10 started at 0 h = A's first → within. B: event 10 started 0 h,
    // B's first is 20 h → 20 h > 12 h. C: no event → miss.
    expect(v.timelineAgreement.numerator).toBe(1);
    expect(v.timelineAgreement.denominator).toBe(3);
    expect(v.fires).toBe(3);
    // n = 8, ΣC(a) = 9, ΣC(b) = C(5,2) = 10, ΣC(n_ij) = 4:
    // E = 9·10/28 = 45/14, max = 9.5 → (4 − 45/14)/(9.5 − 45/14) = 11/88.
    expect(v.ari).toBeCloseTo(0.125, 12);
  });

  it('scores the bottom stratum on its own fires and pairs', () => {
    const v = view('all', '10_50_ha');
    expect(v.pairwiseRecall).toMatchObject({ numerator: 3, denominator: 6 });
    expect(v.pairwisePrecision).toMatchObject({ numerator: 2, denominator: 3 });
    expect(v.overSplitMean).toBe(2);
    expect(v.firesWithoutEvent).toBe(1);
    // Events led by A: 10 (chimera) and 11.
    expect(v.chimeraRate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(v.timelineAgreement).toMatchObject({ numerator: 1, denominator: 2 });
    // n = 5, ΣC(a) = 6, ΣC(b) = C(3,2) = 3, ΣC(n_ij) = 3: E = 1.8, max = 4.5 → 4/9.
    expect(v.ari).toBeCloseTo(4 / 9, 12);
  });

  it('gives a stratum with no hard negatives an unmeasured precision', () => {
    const v = view('all', '50_500_ha');
    expect(v.pairwiseRecall).toMatchObject({ numerator: 1, denominator: 3 });
    expect(v.pairwisePrecision).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(v.pairwiseF1).toBeNull();
    expect(v.chimeraRate).toMatchObject({ numerator: 0, denominator: 1 });
    expect(v.timelineAgreement).toMatchObject({ numerator: 0, denominator: 1 });
    expect(v.ari).toBe(0);
  });

  it('reports every source next to the pooled number', () => {
    const snpp = view(`source:${SNPP}`, '10_50_ha');
    expect(snpp.pairwiseRecall).toEqual(rate(3, 3));
    expect(snpp.pairwisePrecision).toEqual(rate(1, 2));
    expect(snpp.overSplitMean).toBe(1);
    expect(snpp.chimeraRate).toEqual(rate(1, 1));
    expect(snpp.timelineAgreement).toEqual(rate(1, 1));

    const modis = view(`source:${MODIS}`, '10_50_ha');
    expect(modis.pairwiseRecall.rate).toBeNull();
    expect(modis.overSplitMean).toBe(1);
    expect(modis.timelineAgreement).toEqual(rate(1, 1));

    // A's three cross-source pairs (d3 × d0–d2) are all split.
    const cross = view('cross_source', '10_50_ha');
    expect(cross.pairwiseRecall).toMatchObject({ numerator: 0, denominator: 3 });
    expect(cross.pairwisePrecision).toEqual(rate(1, 1));

    const geo = view('attach_only', '10_50_ha');
    expect(geo.firesWithoutEvent).toBe(1);
    expect(geo.timelineAgreement).toMatchObject({ numerator: 0, denominator: 1 });
    expect(view(`source:${SEVIRI}`, 'pooled').firesWithoutEvent).toBe(1);
  });

  it('never puts unlabelled or ambiguous rows in a pairwise metric, but counts their events', () => {
    expect(evaluation.eventCount).toBe(4);
    // Event 13 holds only the ambiguous row: no labelled member, so not judged.
    expect(view('all', 'pooled').chimeraRate.denominator).toBe(3);
  });

  it('pools seasons by adding counts', () => {
    const pooled = poolEvaluations([evaluation, { ...evaluation, season: 2022 }]);
    expect(pooled.eventCount).toBe(8);
    const v = viewOf(pooled.tallies.get(viewKey('all', 'pooled')));
    expect(v.pairwiseRecall).toMatchObject({ numerator: 8, denominator: 18 });
    expect(v.overSplitMean).toBe(2);
    expect(v.fires).toBe(6);
    // Pooling must not mutate the season tallies.
    expect(view('all', 'pooled').pairwiseRecall.numerator).toBe(4);
  });

  it('lists scope `all` views first', () => {
    const keys = allViews(evaluation.tallies).map((v) => v.key);
    expect(keys.slice(0, 3)).toEqual(['all|10_50_ha', 'all|50_500_ha', 'all|pooled']);
    expect(keys).toContain('cross_source|10_50_ha');
  });
});

function tally(overrides: Partial<Tally> = {}): Tally {
  return {
    recallSame: 100,
    recallPairs: 100,
    precisionSeparated: 100,
    precisionPairs: 100,
    overSplit: [1, 1, 1, 1],
    firesWithoutEvent: 0,
    chimeraEvents: 0,
    judgedEvents: 4,
    timelineWithin: 4,
    timelineFires: 4,
    ariPairsBoth: 0,
    ariPairsFire: 0,
    ariPairsEvent: 0,
    ariN: 0,
    ...overrides,
  };
}

describe('verdictOf — GATES §2', () => {
  const params = FIT_PARAMS.values;

  it('passes when the pooled view and the bottom stratum both meet every target', () => {
    const tallies: Tallies = new Map([
      ['all|pooled', tally()],
      ['all|10_50_ha', tally()],
    ]);
    expect(verdictOf(tallies, params).pass).toBe(true);
  });

  it('fails a pooled pass whose bottom stratum fails', () => {
    const tallies: Tallies = new Map([
      ['all|pooled', tally()],
      ['all|10_50_ha', tally({ recallSame: 94 })],
    ]);
    const verdict = verdictOf(tallies, params);
    expect(verdict.views[0]?.pass).toBe(true);
    expect(verdict.views[1]?.pass).toBe(false);
    expect(verdict.views[1]?.checks.find((c) => !c.met)?.metric).toBe('pairwise_recall');
    expect(verdict.pass).toBe(false);
  });

  it('fails an unmeasured bottom stratum', () => {
    const verdict = verdictOf(new Map([['all|pooled', tally()]]), params);
    expect(verdict.pass).toBe(false);
    expect(verdict.views[1]?.checks.every((c) => c.met === null)).toBe(true);
  });

  it('treats every threshold as inclusive', () => {
    const edge = tally({
      recallSame: 95,
      precisionSeparated: 98,
      // mean 1.15, nearest-rank p95 = 2 over 20 samples
      overSplit: [...Array<number>(17).fill(1), 2, 2, 2],
      chimeraEvents: 3,
      judgedEvents: 100,
      timelineWithin: 9,
      timelineFires: 10,
    });
    const verdict = verdictOf(
      new Map([
        ['all|pooled', edge],
        ['all|10_50_ha', edge],
      ]),
      params,
    );
    expect(verdict.views[0]?.checks.map((c) => [c.metric, c.met])).toEqual([
      ['pairwise_recall', true],
      ['pairwise_precision', true],
      ['over_split_mean', true],
      ['over_split_p95', true],
      ['chimera_rate', true],
      ['timeline_agreement', true],
    ]);
  });
});

describe('adjustedRand', () => {
  it('is 1 for identical partitions and null when undefined', () => {
    // Two fires of 2, each its own event: ΣC = 2 everywhere, n = 4.
    expect(
      adjustedRand(tally({ ariPairsBoth: 2, ariPairsFire: 2, ariPairsEvent: 2, ariN: 4 })),
    ).toBe(1);
    expect(adjustedRand(tally({ ariN: 1 }))).toBeNull();
  });
});
