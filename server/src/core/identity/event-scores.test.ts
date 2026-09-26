/**
 * The live D6 score (TASKS D12 wiring): which events a batch rescores, over which rows, and
 * that the answer is `scoreEvent`'s over the canonical member order — the replay's answer.
 */

import type { SourceId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { clusterBatch, emptyState } from '../clustering/engine.js';
import type {
  ClusterBatchResult,
  ClusteringDetection,
  ClusteringState,
} from '../clustering/types.js';
import { epochMsFromIso } from '../ports/clock.js';
import { NO_ALIASES } from '../registry/alias-registry.js';
import type { ScoringDetection } from '../scoring/features.js';
import { scoreEvent } from '../scoring/score.js';
import { SCORE_PARAMS } from '../scoring/score-params.js';
import { eventScores, LIVE_SCORE_CONTEXT, scoringDetectionKeys } from './event-scores.js';
import { planRegistryWrites } from './identity-batch.js';

const SOURCE: SourceId = 'firms:viirs:snpp';
const params = CLUSTERING_PARAMS.values;
const uid = (n: number): string => String(n).padStart(64, '0');

const T1 = '2026-08-05T03:10:00Z';
const T2 = '2026-08-05T15:10:00Z';

/** Every row built here, with the attributes identity never sees and the scorer reads. */
const scoring = new Map<string, ScoringDetection>();

function detection(n: number, availableAt: string, acq: string, lon: string): ClusteringDetection {
  const row: ClusteringDetection = {
    detectionUid: uid(n),
    source: SOURCE,
    availableAt: epochMsFromIso(availableAt),
    acqTsIso: acq,
    latCanonical: '41.86000',
    lonCanonical: lon,
    scanKm: null,
    trackKm: null,
  };
  scoring.set(row.detectionUid, {
    detectionUid: row.detectionUid,
    source: SOURCE,
    acqTsIso: acq,
    latCanonical: row.latCanonical,
    lonCanonical: lon,
    confidence: n % 3 === 0 ? 'high' : 'nominal',
    dayNight: n % 2 === 0 ? 'D' : 'N',
    frpMw: 4 * n,
    scanKm: null,
    trackKm: null,
    overOrAdjacentToWater: null,
  });
  return row;
}

function batch(
  state: ClusteringState,
  availableAt: string,
  detections: readonly ClusteringDetection[],
): ClusterBatchResult {
  return clusterBatch({
    detections,
    state,
    now: epochMsFromIso(availableAt),
    config: CLUSTERING_PARAMS,
  });
}

function aggregatesOf(result: ClusterBatchResult, at: string) {
  return planRegistryWrites({
    result,
    aliases: NO_ALIASES,
    candidates: [],
    alertStates: [],
    params,
    batchAtMs: epochMsFromIso(at),
  }).aggregates;
}

/** What a store answers for the keys: the rows, in an order unlike the keys'. */
function rowsFor(keys: readonly { detectionUid: string }[]): ScoringDetection[] {
  return keys
    .map((key) => {
      const row = scoring.get(key.detectionUid);
      if (row === undefined) throw new Error(`no row ${key.detectionUid}`);
      return row;
    })
    .reverse();
}

// Two events in the first batch; a bridge in the second merges them.
const first = batch(emptyState(), T1, [
  detection(1, T1, '2026-08-05T00:06:00Z', '26.10000'),
  detection(2, T1, '2026-08-05T00:07:00Z', '26.10500'),
  detection(3, T1, '2026-08-05T00:06:00Z', '26.13000'),
]);
const second = batch(first.state, T2, [detection(4, T2, '2026-08-05T12:06:00Z', '26.11500')]);

describe('scoringDetectionKeys', () => {
  it('asks for every member of every rescored event, once, in canonical member order', () => {
    const aggregates = aggregatesOf(first, T1);
    expect(aggregates).toHaveLength(2);
    const keys = scoringDetectionKeys(first, aggregates);
    expect(keys.map((k) => k.detectionUid).sort()).toEqual([uid(1), uid(2), uid(3)]);
    expect(new Set(keys.map((k) => k.detectionUid)).size).toBe(keys.length);
    for (const key of keys) expect(key.acqTsIso).toBe(scoring.get(key.detectionUid)?.acqTsIso);
  });

  it('asks for the whole merged survivor, not only the batch rows', () => {
    expect(second.merges).toHaveLength(1);
    const aggregates = aggregatesOf(second, T2);
    expect(aggregates).toHaveLength(1);
    const keys = scoringDetectionKeys(second, aggregates);
    expect(keys.map((k) => k.detectionUid).sort()).toEqual([uid(1), uid(2), uid(3), uid(4)]);
  });

  it('asks nothing when the batch rescored nothing', () => {
    expect(scoringDetectionKeys(first, [])).toEqual([]);
  });
});

describe('eventScores', () => {
  it("is scoreEvent's answer over the survivor's members, whatever order the store returns", () => {
    const aggregates = aggregatesOf(second, T2);
    const rows = rowsFor(scoringDetectionKeys(second, aggregates));
    const [scored] = eventScores(second, aggregates, rows);
    const survivor = second.state.clusters.find((c) => c.publicId === aggregates[0]?.publicId);
    if (scored === undefined || survivor === undefined) throw new Error('no survivor');
    const inOrder = [...survivor.members]
      .sort((a, b) => (a.detectionUid < b.detectionUid ? -1 : 1))
      .map((m) => scoring.get(m.detectionUid) as ScoringDetection);
    const expected = scoreEvent(inOrder, LIVE_SCORE_CONTEXT);
    expect(scored).toEqual({
      publicId: survivor.publicId,
      score: expected.score,
      invalidated: false,
      paramsVersion: SCORE_PARAMS.version,
    });
    // Deterministic: a second evaluation over a shuffled answer is the same value.
    expect(eventScores(second, aggregates, [...rows].reverse())).toEqual([scored]);
  });

  it('answers one score per aggregate, in aggregate order', () => {
    const aggregates = aggregatesOf(first, T1);
    const scores = eventScores(first, aggregates, rowsFor(scoringDetectionKeys(first, aggregates)));
    expect(scores.map((s) => s.publicId)).toEqual(aggregates.map((a) => a.publicId));
    for (const s of scores) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });

  it('sets invalidated only when the context says the mask hit', () => {
    const aggregates = aggregatesOf(first, T1);
    const rows = rowsFor(scoringDetectionKeys(first, aggregates));
    expect(eventScores(first, aggregates, rows).every((s) => !s.invalidated)).toBe(true);
    const masked = eventScores(first, aggregates, rows, {
      ...LIVE_SCORE_CONTEXT,
      staticSourceMaskHit: true,
    });
    expect(masked.every((s) => s.invalidated)).toBe(true);
  });

  it('refuses to score an event on fewer rows than it holds', () => {
    const aggregates = aggregatesOf(second, T2);
    const rows = rowsFor(scoringDetectionKeys(second, aggregates)).filter(
      (r) => r.detectionUid !== uid(2),
    );
    expect(() => eventScores(second, aggregates, rows)).toThrow(/did not return for scoring/);
  });

  it('refuses an aggregate that is not a cluster of the working set', () => {
    const [aggregate] = aggregatesOf(first, T1);
    if (aggregate === undefined) throw new Error('no aggregate');
    const stray = { ...aggregate, publicId: 'fw-2026-zzzzz' };
    expect(() => scoringDetectionKeys(first, [stray])).toThrow(/not that event/);
    expect(() => eventScores(first, [{ ...aggregate, clusterId: 999 }], [])).toThrow(
      /not that event/,
    );
  });
});

describe('LIVE_SCORE_CONTEXT', () => {
  it('arms nothing: no mask hit, no FWI, no land cover', () => {
    expect(LIVE_SCORE_CONTEXT).toEqual({
      staticSourceMaskHit: false,
      fwiAtLeastHigh: null,
      arableMajorityUnderHull: null,
    });
    expect(Object.isFrozen(LIVE_SCORE_CONTEXT)).toBe(true);
  });
});
