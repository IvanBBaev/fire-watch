/**
 * CI-2 for the identity engine: the same detections must produce the same bytes, twice in
 * a row and whatever order they arrive in.
 *
 * The byte comparison itself is `core/replay/double-run.ts` — deliberately not
 * re-implemented here. A second byte-identity harness would be a second definition of what
 * "identical" means, and the two would eventually disagree about something small enough
 * that nobody notices which one CI is running.
 */

import type { SourceId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { assertDeterministic } from '../replay/double-run.js';
import { CLUSTERING_PARAMS } from './clustering-params.js';
import { clusterBatch, emptyState } from './engine.js';
import { clusteringSnapshot, serializeClusteringOutcome } from './snapshot.js';
import type { ClusterBatchResult, ClusteringDetection } from './types.js';

const VIIRS = 'firms:viirs:snpp';
const MODIS = 'firms:modis';
const SEVIRI = 'lsasaf:seviri:frp-pixel';

const NOW = '2026-08-15T01:00:00Z';

interface Spec {
  readonly uid: string;
  readonly acq: string;
  readonly lat: string;
  readonly availableAt: number;
  readonly source?: SourceId;
  readonly scanKm?: number | null;
  readonly trackKm?: number | null;
}

function detection(spec: Spec): ClusteringDetection {
  return {
    detectionUid: spec.uid,
    source: spec.source ?? VIIRS,
    availableAt: spec.availableAt,
    acqTsIso: spec.acq,
    latCanonical: spec.lat,
    lonCanonical: '23.50000',
    scanKm: spec.scanKm ?? null,
    trackKm: spec.trackKm ?? null,
  };
}

/**
 * One batch that reaches every branch of the algorithm: three seeds, four attachments, a
 * fine-source merge, a coarse attachment, a coarse row that joins nothing, and a MODIS row
 * whose footprint is defaulted. A determinism proof over a batch of seeds alone would be
 * green while the merge path shuffled its output.
 */
const MIXED_BATCH: readonly ClusteringDetection[] = [
  detection({ uid: 'v1', acq: '2026-08-15T00:00:00Z', lat: '41.90000', availableAt: 1 }),
  detection({ uid: 'v2', acq: '2026-08-15T00:06:00Z', lat: '41.91000', availableAt: 2 }),
  detection({ uid: 'v3', acq: '2026-08-15T00:12:00Z', lat: '41.93000', availableAt: 3 }),
  detection({ uid: 'v4', acq: '2026-08-15T00:18:00Z', lat: '41.92000', availableAt: 4 }),
  detection({
    uid: 'g1',
    acq: '2026-08-15T00:30:00Z',
    lat: '41.95000',
    availableAt: 5,
    source: SEVIRI,
  }),
  detection({
    uid: 'g2',
    acq: '2026-08-15T00:30:00Z',
    lat: '43.00000',
    availableAt: 6,
    source: SEVIRI,
  }),
  detection({
    uid: 'm1',
    acq: '2026-08-15T00:36:00Z',
    lat: '42.50000',
    availableAt: 7,
    source: MODIS,
  }),
  detection({
    uid: 'm2',
    acq: '2026-08-15T00:42:00Z',
    lat: '42.52000',
    availableAt: 8,
    source: MODIS,
    scanKm: 1,
    trackKm: 2,
  }),
];

function runBatch(
  detections: readonly ClusteringDetection[],
  now: string = NOW,
  state = emptyState(),
): ClusterBatchResult {
  return clusterBatch({
    detections,
    state,
    now: epochMsFromIso(now),
    config: CLUSTERING_PARAMS,
  });
}

/**
 * A fixed permutation. Not `Math.random` — which is banned in the core and would make a
 * failure unreproducible anyway — but an LCG whose seed is written down, so a shuffle that
 * breaks the engine breaks it again on the next run and on the reviewer's machine.
 */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

describe('the batch outcome is byte-identical on a repeat run (CI-2)', () => {
  it('produces the same bytes twice, built from scratch each time', () => {
    // `produce` rebuilds the state as well as the batch: sharing one across the two runs
    // would make the second a continuation rather than a repeat, and a `Map` iterated in
    // insertion order would pass.
    const report = assertDeterministic('clustering/mixed-batch', () =>
      serializeClusteringOutcome(runBatch(MIXED_BATCH)),
    );
    expect(report.endsWith('\n')).toBe(true);
    expect(report).toContain('"configVersion":"clustering_params_v1"');
  });

  it('reaches the branches the proof is supposed to cover', () => {
    // A determinism proof over a trivial batch is a determinism proof over nothing. This is
    // the guard that keeps the batch above interesting after someone edits it.
    const result = runBatch(MIXED_BATCH);
    expect(result.stats).toEqual({
      detections: 8,
      seeded: 3,
      attached: 4,
      merged: 1,
      unattached: 1,
      alreadyAssigned: 0,
      footprintDefaulted: 1,
      evicted: 0,
    });
    expect(result.merges).toHaveLength(1);
    expect(result.state.clusters).toHaveLength(2);
  });

  it('emits no floating-point residue into the artifact', () => {
    // Distances, ε and centroids are all floats inside the engine. Everything that leaves
    // it is an integer, a 5-decimal coordinate string or an ISO instant — a `1.2497062500005`
    // in a checked-in `expected.json` is a diff waiting to happen on another machine.
    const report = serializeClusteringOutcome(runBatch(MIXED_BATCH));
    expect(report).not.toMatch(/\d\.\d{7,}/);
  });
});

describe('the arrival order of a batch is not part of the answer', () => {
  const canonical = serializeClusteringOutcome(runBatch(MIXED_BATCH));

  it('gives the same bytes for sixteen different input permutations', () => {
    // The database returns rows in physical order, a replay re-reads them from a file, two
    // sources interleave differently on the second poll. All of those are the same batch.
    for (let seed = 1; seed <= 16; seed += 1) {
      const permuted = shuffled(MIXED_BATCH, seed);
      expect(serializeClusteringOutcome(runBatch(permuted))).toBe(canonical);
    }
  });

  it('actually permutes — the shuffle is doing work', () => {
    const permuted = shuffled(MIXED_BATCH, 7);
    expect(permuted.map((d) => d.detectionUid)).not.toEqual(MIXED_BATCH.map((d) => d.detectionUid));
    expect([...permuted].sort()).toHaveLength(MIXED_BATCH.length);
  });

  it('gives the same events whether the rows arrive in one batch or two', () => {
    // The reprocessing property: an SP re-cluster replays the same detections through
    // different batch boundaries, and the fires it produces must be the ones already
    // published — same members, same centroids, same public ids.
    const split = MIXED_BATCH.length / 2;
    const first = runBatch(MIXED_BATCH.slice(0, split), '2026-08-15T00:20:00Z');
    const second = runBatch(MIXED_BATCH.slice(split), NOW, first.state);

    expect(clusteringSnapshot(second).clusters).toEqual(
      clusteringSnapshot(runBatch(MIXED_BATCH)).clusters,
    );
  });
});

describe('replaying a batch on top of its own output changes nothing', () => {
  it('is a fixed point — the property an overlapping poll depends on', () => {
    const first = runBatch(MIXED_BATCH);
    const again = runBatch(MIXED_BATCH, '2026-08-15T01:30:00Z', first.state);

    // Seven of the eight rows joined a cluster and are skipped on sight.
    expect(again.stats.alreadyAssigned).toBe(7);
    expect(again.stats.seeded).toBe(0);
    expect(again.stats.attached).toBe(0);
    expect(again.assignments).toEqual([]);
    expect(again.merges).toEqual([]);
    expect(clusteringSnapshot(again).clusters).toEqual(clusteringSnapshot(first).clusters);
  });

  it('re-offers a coarse row that joined nothing, in case an event has appeared since', () => {
    // The eighth row is the GEO detection with no candidate. It is not a member of
    // anything, so it is reconsidered on every poll that re-delivers it — which is the
    // point: a fine detection arriving an hour later creates the event the pixel was
    // corroborating all along, and the pixel should then join it rather than stay lost
    // because the first poll saw it too early.
    const first = runBatch(MIXED_BATCH);
    const again = runBatch(MIXED_BATCH, '2026-08-15T01:30:00Z', first.state);
    expect(again.unattached.map((row) => row.detectionUid)).toEqual(['g2']);

    const withFine = runBatch(
      [detection({ uid: 'v9', acq: '2026-08-15T01:00:00Z', lat: '43.00000', availableAt: 9 })],
      '2026-08-15T01:30:00Z',
      first.state,
    );
    expect(withFine.stats.seeded).toBe(1);

    const rediscovered = runBatch(MIXED_BATCH, '2026-08-15T02:00:00Z', withFine.state);
    expect(rediscovered.unattached).toEqual([]);
    expect(rediscovered.assignments.map((assignment) => assignment.detectionUid)).toEqual(['g2']);
    expect(rediscovered.stats.attached).toBe(1);
  });
});
