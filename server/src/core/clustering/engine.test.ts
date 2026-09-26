import type { SourceId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import { epochMsFromIso } from '../ports/clock.js';
import { CLUSTERING_PARAMS, type ClusteringParams } from './clustering-params.js';
import { clusterBatch, emptyState } from './engine.js';
import { distanceKm, quantizeKm } from './geometry.js';
import { PUBLIC_ID_RE } from './public-id.js';
import type {
  ClusterBatchResult,
  ClusteringConfig,
  ClusteringDetection,
  ClusteringState,
} from './types.js';

const VIIRS = 'firms:viirs:snpp';
const MODIS = 'firms:modis';
const SEVIRI = 'lsasaf:seviri:frp-pixel';

const metric = CLUSTERING_PARAMS.values.metric;
const LON = '23.50000';
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Distances are measured along a meridian at a fixed longitude, so a coordinate step is
 * `Δlat · 111.085 km` and every boundary below is arithmetic a reader can check by hand.
 * With ε = 1.25 km for VIIRS: 0.01125° is 1.2497 km (inside), 0.01126° is 1.2508 km
 * (outside). Those two rows are one step apart on the 5-decimal grid the archive stores,
 * which is as close to the boundary as real data can get.
 */
const AT_41_90 = '41.90000';
const INSIDE_EPS = '41.91125';
const OUTSIDE_EPS = '41.91126';

interface DetectionSpec {
  readonly uid: string;
  readonly acq: string;
  readonly lat: string;
  readonly lon?: string;
  readonly source?: SourceId;
  /** Defaults to the acquisition instant; set it explicitly to control the batch order. */
  readonly availableAt?: number;
  readonly scanKm?: number | null;
  readonly trackKm?: number | null;
}

function detection(spec: DetectionSpec): ClusteringDetection {
  return {
    detectionUid: spec.uid,
    source: spec.source ?? VIIRS,
    availableAt: spec.availableAt ?? epochMsFromIso(spec.acq),
    acqTsIso: spec.acq,
    latCanonical: spec.lat,
    lonCanonical: spec.lon ?? LON,
    scanKm: spec.scanKm ?? null,
    trackKm: spec.trackKm ?? null,
  };
}

interface RunOptions {
  readonly now: string;
  readonly state?: ClusteringState;
  readonly config?: ClusteringConfig;
}

function run(detections: readonly ClusteringDetection[], options: RunOptions): ClusterBatchResult {
  return clusterBatch({
    detections,
    state: options.state ?? emptyState(),
    now: epochMsFromIso(options.now),
    config: options.config ?? CLUSTERING_PARAMS,
  });
}

/** A parameter set identical to v1 except for the VIIRS ε — for the exact-boundary tests. */
function viirsEps(km: number): ClusteringConfig {
  const values: ClusteringParams = {
    ...CLUSTERING_PARAMS.values,
    epsBySource: {
      ...CLUSTERING_PARAMS.values.epsBySource,
      [VIIRS]: { kind: 'fixed', km },
    },
  };
  return defineConfig<ClusteringParams>('clustering_params', 'clustering_params_test_v1', values);
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item === undefined) throw new Error('expected exactly one item');
  return item;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${String(index)}`);
  return item;
}

// ── 0 candidates → create cluster (seed) ────────────────────────────────────────────────

describe('a detection with no candidate seeds an event (ADR-002 D2, "0 candidates")', () => {
  it('creates the cluster, mints its id, and reports it as seeded', () => {
    const result = run([detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 })], {
      now: '2026-08-15T09:10:00Z',
    });

    const cluster = only(result.state.clusters);
    expect(cluster.id).toBe(1);
    expect(cluster.publicId).toMatch(PUBLIC_ID_RE);
    expect(cluster.seedDetectionUid).toBe('a');
    expect(cluster.startedAt).toBe(epochMsFromIso('2026-08-15T09:00:00Z'));
    expect(cluster.lastDetectionAt).toBe(cluster.startedAt);
    expect(result.state.nextClusterId).toBe(2);
    expect(result.state.takenPublicIds).toEqual([cluster.publicId]);

    const seeded = only(result.seeded);
    expect(seeded).toEqual({
      clusterId: 1,
      publicId: cluster.publicId,
      seedDetectionUid: 'a',
      source: VIIRS,
      startedAtIso: '2026-08-15T09:00:00Z',
      coordinate: { lat: 41.9, lon: 23.5 },
      epsKm: 1.25,
    });

    const assignment = only(result.assignments);
    expect(assignment.kind).toBe('seed');
    expect(assignment.clusterId).toBe(1);
    expect(assignment.distanceQuanta).toBe(0);
    expect(result.stats).toEqual({
      detections: 1,
      seeded: 1,
      attached: 0,
      merged: 0,
      unattached: 0,
      alreadyAssigned: 0,
      footprintDefaulted: 0,
      evicted: 0,
    });
  });

  it('promotes on creation — the working set and the event registry are 1:1', () => {
    // D2 "Promotion": a cluster becomes a FireEvent immediately, with no minimum detection
    // count and no confirmation delay. A fire that is only ever seen once is still a fire
    // somebody may need to look at.
    const result = run([detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 })], {
      now: '2026-08-15T09:10:00Z',
    });
    expect(only(result.state.clusters).members).toHaveLength(1);
    expect(result.seeded).toHaveLength(1);
  });

  it('lets a cluster seeded earlier in the same batch absorb a later detection', () => {
    // The batch is a continuation of the working set, not a fresh DBSCAN over a window.
    // Without this the second row would seed its own event and a fire that grew during one
    // poll would arrive on the map as two.
    const result = run(
      [
        detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'b', acq: '2026-08-15T09:06:00Z', lat: INSIDE_EPS }),
      ],
      { now: '2026-08-15T09:10:00Z' },
    );
    expect(result.state.clusters).toHaveLength(1);
    expect(only(result.state.clusters).members).toHaveLength(2);
    expect(result.stats.attached).toBe(1);
  });
});

// ── ε — Appendix A rule 3, inclusive ────────────────────────────────────────────────────

describe('ε decides membership, inclusively (Appendix A rule 3)', () => {
  it('attaches a detection one grid step inside ε', () => {
    const result = run(
      [
        detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'b', acq: '2026-08-15T09:06:00Z', lat: INSIDE_EPS }),
      ],
      { now: '2026-08-15T09:10:00Z' },
    );
    expect(result.state.clusters).toHaveLength(1);
    const attach = at(result.assignments, 1);
    expect(attach.kind).toBe('attach');
    expect(attach.distanceQuanta).toBe(
      quantizeKm(
        distanceKm({ lat: 41.9, lon: 23.5 }, { lat: 41.91125, lon: 23.5 }, metric),
        metric,
      ),
    );
  });

  it('seeds a second event for a detection one grid step outside ε', () => {
    const result = run(
      [
        detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'b', acq: '2026-08-15T09:06:00Z', lat: OUTSIDE_EPS }),
      ],
      { now: '2026-08-15T09:10:00Z' },
    );
    expect(result.state.clusters).toHaveLength(2);
    expect(result.stats.seeded).toBe(2);
  });

  it('admits a detection at exactly ε, and refuses one a single quantum beyond it', () => {
    // The boundary itself, reached by tuning ε to the distance rather than the distance to
    // ε. "Exactly ε is inside" is a choice — the alternative is defensible and produces a
    // different event graph — so it is pinned here in the engine, not only in `withinKm`.
    const exact = distanceKm({ lat: 41.9, lon: 23.5 }, { lat: 41.91125, lon: 23.5 }, metric);
    const batch = [
      detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 }),
      detection({ uid: 'b', acq: '2026-08-15T09:06:00Z', lat: INSIDE_EPS }),
    ];

    const inclusive = run(batch, { now: '2026-08-15T09:10:00Z', config: viirsEps(exact) });
    expect(inclusive.state.clusters).toHaveLength(1);

    const exclusive = run(batch, {
      now: '2026-08-15T09:10:00Z',
      config: viirsEps(exact - 2 * metric.quantumKm),
    });
    expect(exclusive.state.clusters).toHaveLength(2);
  });

  it('measures to the nearest member, not to the centroid (single link)', () => {
    // A fire front is longer than ε within hours. Five detections 0.011° apart form a chain
    // whose ends are nowhere near each other; a centroid test would break it into separate
    // events as it advanced, each with its own public id and its own alert.
    const result = run(
      [
        detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: '41.90000' }),
        detection({ uid: 'b', acq: '2026-08-15T09:06:00Z', lat: '41.91100' }),
        detection({ uid: 'c', acq: '2026-08-15T09:12:00Z', lat: '41.92200' }),
        detection({ uid: 'd', acq: '2026-08-15T09:18:00Z', lat: '41.93300' }),
        detection({ uid: 'e', acq: '2026-08-15T09:24:00Z', lat: '41.94400' }),
      ],
      { now: '2026-08-15T09:30:00Z' },
    );
    expect(result.state.clusters).toHaveLength(1);
    expect(only(result.state.clusters).members).toHaveLength(5);
    // End to end is 4.9 km — nearly four ε — and even the *centroid* of the chain is 2.4 km
    // from either end, so a centroid test would have split it twice over.
    expect(
      distanceKm({ lat: 41.9, lon: 23.5 }, { lat: 41.944, lon: 23.5 }, metric),
    ).toBeGreaterThan(3 * 1.25);
    expect(
      distanceKm({ lat: 41.9, lon: 23.5 }, { lat: 41.922, lon: 23.5 }, metric),
    ).toBeGreaterThan(1.25);
  });

  it('gives each source its own ε', () => {
    // MODIS ε is 3 km against VIIRS's 1.25 km, so the same 2.2 km gap resolves differently
    // depending on which instrument saw the second row. That is the point of a per-source
    // ε: the radius describes the instrument's uncertainty, not the fire's shape.
    const far = '41.92000'; // 2.2217 km from 41.90000
    const viirs = run(
      [
        detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'b', acq: '2026-08-15T09:06:00Z', lat: far }),
      ],
      { now: '2026-08-15T09:10:00Z' },
    );
    expect(viirs.state.clusters).toHaveLength(2);

    const modis = run(
      [
        detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'b', acq: '2026-08-15T09:06:00Z', lat: far, source: MODIS }),
      ],
      { now: '2026-08-15T09:10:00Z' },
    );
    expect(modis.state.clusters).toHaveLength(1);
  });
});

// ── T_LINK ──────────────────────────────────────────────────────────────────────────────

describe('T_LINK bounds the temporal gap, inclusively (Appendix A rule 3)', () => {
  it('attaches a detection exactly T_LINK after the cluster was last seen', () => {
    const result = run(
      [
        detection({ uid: 'a', acq: '2026-08-13T00:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'b', acq: '2026-08-15T00:00:00Z', lat: AT_41_90 }),
      ],
      { now: '2026-08-15T01:00:00Z' },
    );
    expect(result.state.clusters).toHaveLength(1);
    expect(only(result.state.clusters).members).toHaveLength(2);
  });

  it('seeds a new event one acquisition minute past T_LINK', () => {
    // One minute is the resolution `acq_ts` is stored at, so this is the smallest step the
    // data can take across the boundary. The new event is the reignition candidate D3 then
    // decides whether to link.
    const result = run(
      [
        detection({ uid: 'a', acq: '2026-08-13T00:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'b', acq: '2026-08-15T00:01:00Z', lat: AT_41_90 }),
      ],
      { now: '2026-08-15T01:00:00Z' },
    );
    expect(result.state.clusters).toHaveLength(2);
    expect(result.seeded).toHaveLength(2);
    // The seam D3 reads: where the new event started, and at what radius, so it can look
    // for a parent within 2·ε. The engine itself makes no reignition claim.
    expect(at(result.seeded, 1).epsKm).toBe(1.25);
    expect(at(result.seeded, 1).coordinate).toEqual({ lat: 41.9, lon: 23.5 });
  });

  it('measures the gap to the cluster span, so a late row lands in the fire it belongs to', () => {
    // A row can arrive days after it was acquired — a provider backfill, an SP re-cluster,
    // a source whose availability lags. Measured against `last_detection_at` alone, a
    // detection from the middle of a week-long fire scores as 72 h away and seeds a second
    // event *inside* the first one. Inside the cluster's own span the gap is zero, which is
    // the only answer that is true of a fire that was burning at that moment.
    const first = run(
      [
        detection({ uid: 'a', acq: '2026-08-09T00:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'b', acq: '2026-08-11T00:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'c', acq: '2026-08-13T00:00:00Z', lat: AT_41_90 }),
        detection({ uid: 'd', acq: '2026-08-15T00:00:00Z', lat: AT_41_90 }),
      ],
      { now: '2026-08-15T01:00:00Z' },
    );
    expect(first.state.clusters).toHaveLength(1);

    const late = run(
      [
        detection({
          uid: 'late',
          acq: '2026-08-12T00:00:00Z',
          lat: AT_41_90,
          availableAt: epochMsFromIso('2026-08-15T02:00:00Z'),
        }),
      ],
      { now: '2026-08-15T02:00:00Z', state: first.state },
    );
    expect(late.state.clusters).toHaveLength(1);
    expect(late.stats.attached).toBe(1);
    // Against `last_detection_at` the gap would be 72 h, well past the 48 h T_LINK.
    expect(epochMsFromIso('2026-08-15T00:00:00Z') - epochMsFromIso('2026-08-12T00:00:00Z')).toBe(
      72 * HOUR_MS,
    );
  });
});

// ── The 72 h active window ──────────────────────────────────────────────────────────────

describe('the active window retires a cluster from the working set', () => {
  const seedBatch = [detection({ uid: 'a', acq: '2026-08-12T00:00:00Z', lat: AT_41_90 })];

  it('keeps a cluster at exactly 72 h of silence (Appendix A rule 3)', () => {
    const seeded = run(seedBatch, { now: '2026-08-12T00:00:00Z' });
    const later = run([], { now: '2026-08-15T00:00:00Z', state: seeded.state });
    expect(later.evictedClusterIds).toEqual([]);
    expect(later.state.clusters).toHaveLength(1);
  });

  it('evicts it one minute later', () => {
    const seeded = run(seedBatch, { now: '2026-08-12T00:00:00Z' });
    const later = run([], { now: '2026-08-15T00:01:00Z', state: seeded.state });
    expect(later.evictedClusterIds).toEqual([1]);
    expect(later.state.clusters).toEqual([]);
    expect(later.stats.evicted).toBe(1);
  });

  it('keeps the retired cluster´s public id reserved forever (I1)', () => {
    const seeded = run(seedBatch, { now: '2026-08-12T00:00:00Z' });
    const publicId = only(seeded.state.clusters).publicId;
    const later = run([], { now: '2026-08-15T00:01:00Z', state: seeded.state });
    expect(later.state.takenPublicIds).toContain(publicId);
    expect(later.state.nextClusterId).toBe(2);
  });

  it('does not offer an evicted cluster as a candidate', () => {
    const seeded = run(seedBatch, { now: '2026-08-12T00:00:00Z' });
    const later = run([detection({ uid: 'b', acq: '2026-08-15T00:30:00Z', lat: AT_41_90 })], {
      now: '2026-08-15T00:31:00Z',
      state: seeded.state,
    });
    expect(later.stats.seeded).toBe(1);
    expect(only(later.state.clusters).id).toBe(2);
  });
});

// ── Idempotence under overlapping polls ─────────────────────────────────────────────────

describe('a re-delivered detection joins nothing twice', () => {
  const batch = [detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 })];

  it('skips a row that is already a member of a cluster', () => {
    // The poller asks for `day_range=2` on purpose, so every poll re-delivers most of the
    // previous one. Re-delivery is the normal case, not an error — but it must not produce
    // a second event, or a second row in an append-only assignment table.
    const first = run(batch, { now: '2026-08-15T09:10:00Z' });
    const second = run(batch, { now: '2026-08-15T09:20:00Z', state: first.state });

    expect(second.stats.alreadyAssigned).toBe(1);
    expect(second.stats.seeded).toBe(0);
    expect(second.assignments).toEqual([]);
    expect(second.state.clusters).toEqual(first.state.clusters);
  });

  it('still skips it after its cluster has aged out of the working set', () => {
    // The membership index is built *before* eviction. Without that, an overlapping poll
    // arriving just past the 72 h window would find no cluster holding the row, seed a
    // fresh event for a detection that already has one, and publish a second public id for
    // a fire that already had one.
    const first = run(batch, { now: '2026-08-15T09:10:00Z' });
    const second = run(batch, { now: '2026-08-18T10:00:00Z', state: first.state });

    expect(second.evictedClusterIds).toEqual([1]);
    expect(second.stats.alreadyAssigned).toBe(1);
    expect(second.stats.seeded).toBe(0);
    expect(second.state.clusters).toEqual([]);
  });
});

// ── Coarse / GEO: attach-only (A1.5 + Appendix A rule 1) ────────────────────────────────

describe('a coarse source attaches, and only attaches (A1.5)', () => {
  it('never creates an event on its own', () => {
    // A ~5 km geostationary pixel on its own is a heat signal nobody can point at. The row
    // stays in the archive and on the map; it simply is not evidence that an event exists.
    const result = run(
      [detection({ uid: 'geo', acq: '2026-08-15T09:00:00Z', lat: AT_41_90, source: SEVIRI })],
      { now: '2026-08-15T09:10:00Z' },
    );
    expect(result.state.clusters).toEqual([]);
    expect(result.assignments).toEqual([]);
    expect(result.seeded).toEqual([]);
    expect(only(result.unattached)).toEqual({
      detectionUid: 'geo',
      source: SEVIRI,
      reason: 'coarse_no_candidate',
    });
    expect(result.state.takenPublicIds).toEqual([]);
  });

  it('corroborates an existing event, and is reported as a non-fine touch (the D4 seam)', () => {
    const seeded = run([detection({ uid: 'a', acq: '2026-08-15T00:00:00Z', lat: AT_41_90 })], {
      now: '2026-08-15T00:10:00Z',
    });
    const corroborated = run(
      [detection({ uid: 'geo', acq: '2026-08-15T06:00:00Z', lat: '41.92000', source: SEVIRI })],
      { now: '2026-08-15T06:10:00Z', state: seeded.state },
    );

    expect(corroborated.state.clusters).toHaveLength(1);
    expect(only(corroborated.state.clusters).members).toHaveLength(2);
    const touched = only(corroborated.touched);
    expect(touched.clusterId).toBe(1);
    expect(touched.attachedCount).toBe(1);
    // A2.2: `officially_*` → `active` requires a *fine* re-detection. A GEO pixel alone
    // must not resurrect an event a fire service has declared out.
    expect(touched.fineAttached).toBe(false);
    expect(touched.previousLastDetectionAtIso).toBe('2026-08-15T00:00:00Z');
    expect(touched.lastDetectionAtIso).toBe('2026-08-15T06:00:00Z');
    expect(touched.gapMs).toBe(6 * HOUR_MS);
  });

  it('never merges two events, however many it can reach', () => {
    // The flip case, side by side with the fine-source merge below: identical geometry,
    // identical timing, one field different. A GEO pixel covers both clusters and half the
    // valley between them; letting it bridge would fuse two real fires into a chimera that
    // then keeps one of the two already-published ids.
    const two = run(
      [
        detection({ uid: 'north', acq: '2026-08-15T00:00:00Z', lat: '41.92000' }),
        detection({ uid: 'south', acq: '2026-08-15T00:06:00Z', lat: '41.90000' }),
      ],
      { now: '2026-08-15T00:10:00Z' },
    );
    expect(two.state.clusters).toHaveLength(2);

    const geo = run(
      [
        detection({
          uid: 'bridge',
          acq: '2026-08-15T01:00:00Z',
          lat: '41.91500',
          source: SEVIRI,
        }),
      ],
      { now: '2026-08-15T01:10:00Z', state: two.state },
    );
    expect(geo.merges).toEqual([]);
    expect(geo.state.clusters).toHaveLength(2);
    // Nearest wins: 0.56 km to the northern cluster against 1.67 km to the southern one.
    expect(only(geo.assignments).clusterId).toBe(1);
  });
});

describe('Appendix A rule 1 — an equidistant coarse row goes to the lowest cluster id', () => {
  // "A coarse/GEO detection within ε of several clusters attaches to the nearest; if two
  // are equidistant, to the one with the lowest internal cluster id."
  //
  // Not a hypothetical: a fire that split around a ridge is two clusters symmetric about
  // one geostationary pixel, and the 1 mm quantum makes "exactly equidistant" a state the
  // engine actually reaches rather than a case floating-point noise decides.

  function twoClustersThenGeo(northFirst: boolean): ClusterBatchResult {
    const north = detection({
      uid: 'north',
      acq: '2026-08-15T00:00:00Z',
      lat: '41.94000',
      availableAt: northFirst ? 1 : 2,
    });
    const south = detection({
      uid: 'south',
      acq: '2026-08-15T00:00:00Z',
      lat: '41.90000',
      availableAt: northFirst ? 2 : 1,
    });
    const seeded = run([north, south], { now: '2026-08-15T00:10:00Z' });
    expect(seeded.state.clusters).toHaveLength(2);
    return run(
      [
        detection({
          uid: 'geo',
          acq: '2026-08-15T01:00:00Z',
          lat: '41.92000',
          source: SEVIRI,
        }),
      ],
      { now: '2026-08-15T01:10:00Z', state: seeded.state },
    );
  }

  it('is genuinely a tie on the quantised grid', () => {
    const toNorth = distanceKm({ lat: 41.92, lon: 23.5 }, { lat: 41.94, lon: 23.5 }, metric);
    const toSouth = distanceKm({ lat: 41.92, lon: 23.5 }, { lat: 41.9, lon: 23.5 }, metric);
    expect(toNorth).not.toBe(toSouth); // the raw doubles differ …
    expect(quantizeKm(toNorth, metric)).toBe(quantizeKm(toSouth, metric)); // … the quanta do not
  });

  it('picks cluster 1 when the southern fire was seen first', () => {
    const result = twoClustersThenGeo(false);
    const assignment = only(result.assignments);
    expect(assignment.clusterId).toBe(1);
    expect(at(result.state.clusters, 0).seedDetectionUid).toBe('south');
  });

  it('picks cluster 1 when the northern fire was seen first — the id, not the geography', () => {
    // Same two fires, same pixel, same distances; only the order the two events were
    // created in differs. The winner follows the id, which is what makes the outcome a
    // property of the archive rather than of whichever row the poller happened to see
    // first. Under "first candidate found" or "nearest, ties to whichever the working set
    // lists first" both of these tests would still pass — under "lowest public id" or
    // "northernmost" exactly one of them would fail.
    const result = twoClustersThenGeo(true);
    const assignment = only(result.assignments);
    expect(assignment.clusterId).toBe(1);
    expect(at(result.state.clusters, 0).seedDetectionUid).toBe('north');
  });
});

// ── N candidates, fine source → merge (D2 + D3 rule 1) ──────────────────────────────────

describe('a fine detection within ε of several clusters merges them (D2, "N candidates")', () => {
  /**
   * Two events, then one fine row between them.
   *
   * The southern event starts a day earlier but is created *second*, so the survivor is
   * decided by `started_at` and not by the internal id — the two keys disagree here on
   * purpose, because a test where they agree cannot tell which one the code is using.
   */
  function bridged(bridgeSource: SourceId): ClusterBatchResult {
    return run(
      [
        detection({ uid: 'north', acq: '2026-08-15T00:00:00Z', lat: '41.92000', availableAt: 1 }),
        detection({ uid: 'south', acq: '2026-08-14T00:00:00Z', lat: '41.90000', availableAt: 2 }),
        detection({
          uid: 'bridge',
          acq: '2026-08-15T01:00:00Z',
          lat: '41.91000',
          availableAt: 3,
          source: bridgeSource,
        }),
      ],
      { now: '2026-08-15T02:00:00Z' },
    );
  }

  it('unions them and keeps the oldest event, not the lowest id (D3 rule 1)', () => {
    const result = bridged(VIIRS);
    const cluster = only(result.state.clusters);
    expect(cluster.id).toBe(2);
    expect(cluster.seedDetectionUid).toBe('south');
    expect(cluster.startedAt).toBe(epochMsFromIso('2026-08-14T00:00:00Z'));
    expect(cluster.lastDetectionAt).toBe(epochMsFromIso('2026-08-15T01:00:00Z'));
    expect(cluster.members.map((member) => member.detectionUid)).toEqual([
      'south',
      'north',
      'bridge',
    ]);

    const merge = only(result.merges);
    expect(merge.survivorClusterId).toBe(2);
    expect(merge.survivorPublicId).toBe(cluster.publicId);
    expect(merge.absorbedClusterIds).toEqual([1]);
    expect(merge.absorbedPublicIds).toHaveLength(1);
    expect(merge.bridgedByDetectionUid).toBe('bridge');
    expect(result.stats.merged).toBe(1);
  });

  it('rewrites the assignments already emitted for the absorbed cluster', () => {
    // `north` was assigned to cluster 1 earlier in the same batch. `event_detections` must
    // not end up with a row pointing at a cluster that no longer exists.
    const result = bridged(VIIRS);
    for (const assignment of result.assignments) {
      expect(assignment.clusterId).toBe(2);
      expect(assignment.publicId).toBe(only(result.state.clusters).publicId);
    }
    expect(result.assignments).toHaveLength(3);
  });

  it('keeps the absorbed public id reserved, so it can become an alias (D3)', () => {
    const result = bridged(VIIRS);
    const merge = only(result.merges);
    expect(result.state.takenPublicIds).toContain(at(merge.absorbedPublicIds, 0));
    expect(result.state.nextClusterId).toBe(3);
  });

  it('folds the two touch records into one, for D4', () => {
    const result = bridged(VIIRS);
    const touched = only(result.touched);
    expect(touched.clusterId).toBe(2);
    // Two seeds plus the bridging attachment, all of them in this batch.
    expect(touched.attachedCount).toBe(3);
    expect(touched.fineAttached).toBe(true);
    expect(touched.previousLastDetectionAtIso).toBeNull();
  });

  it('leaves both events standing when the same geometry is bridged by a coarse row', () => {
    const result = bridged(SEVIRI);
    expect(result.merges).toEqual([]);
    expect(result.state.clusters).toHaveLength(2);
    expect(result.stats.merged).toBe(0);
  });
});

// ── Provenance ──────────────────────────────────────────────────────────────────────────

describe('provenance is stamped on everything the batch produces', () => {
  it('records the parameter version and digest the batch ran under', () => {
    const result = run([detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 })], {
      now: '2026-08-15T09:10:00Z',
    });
    expect(result.configVersion).toBe('clustering_params_v1');
    expect(result.configDigest).toBe(CLUSTERING_PARAMS.digest);
    expect(result.sourceRegistryVersion).toMatch(/^source_registry_v\d+$/);

    const cluster = only(result.state.clusters);
    expect(cluster.configVersion).toBe('clustering_params_v1');
    expect(cluster.sourceRegistryVersion).toBe(result.sourceRegistryVersion);
  });

  it('does not re-stamp an event created under an earlier parameter version', () => {
    // A replay under v2 must not silently rewrite what v1 decided; the event carries the
    // version it was clustered under so a report can say which rules produced it.
    const first = run([detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 })], {
      now: '2026-08-15T09:10:00Z',
    });
    const second = run([detection({ uid: 'b', acq: '2026-08-15T09:06:00Z', lat: INSIDE_EPS })], {
      now: '2026-08-15T09:20:00Z',
      state: first.state,
      config: viirsEps(1.25),
    });
    expect(only(second.state.clusters).configVersion).toBe('clustering_params_v1');
    expect(second.configVersion).toBe('clustering_params_test_v1');
  });

  it('counts the defaulted footprints of the batch (Appendix A rule 4)', () => {
    const result = run(
      [
        detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90, source: MODIS }),
        detection({
          uid: 'b',
          acq: '2026-08-15T09:06:00Z',
          lat: '41.95000',
          source: MODIS,
          scanKm: 4.8,
          trackKm: 2,
        }),
      ],
      { now: '2026-08-15T09:10:00Z' },
    );
    expect(result.stats.footprintDefaulted).toBe(1);
    const defaulted = at(result.assignments, 0);
    expect(defaulted.footprintDefaulted).toBe(true);
    expect(defaulted.epsKm).toBe(3);
    expect(at(result.assignments, 1).footprintDefaulted).toBe(false);
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────────────────

describe('the engine refuses input it cannot cluster deterministically', () => {
  it('rejects two detections that share an ordering key', () => {
    // A tie in the batch order means two distinct rows share a `detection_uid` — an
    // identity bug upstream. Clustering them anyway would put the outcome at the mercy of
    // the sort's stability.
    const one = detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: AT_41_90 });
    expect(() => run([one, { ...one }], { now: '2026-08-15T09:10:00Z' })).toThrow(
      /ordering is not total/,
    );
  });

  it('rejects a non-finite batch instant', () => {
    expect(() =>
      clusterBatch({
        detections: [],
        state: emptyState(),
        now: Number.NaN,
        config: CLUSTERING_PARAMS,
      }),
    ).toThrow(RangeError);
  });

  it('rejects a coordinate that is not canonical 5-decimal text', () => {
    expect(() =>
      run([detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: '41.9' })], {
        now: '2026-08-15T09:10:00Z',
      }),
    ).toThrow(RangeError);
  });
});

// ── Output ordering ─────────────────────────────────────────────────────────────────────

describe('every emitted list is in a fixed order', () => {
  it('sorts assignments by acquisition time, then uid', () => {
    const result = run(
      [
        detection({ uid: 'z', acq: '2026-08-15T09:00:00Z', lat: AT_41_90, availableAt: 3 }),
        detection({ uid: 'a', acq: '2026-08-15T09:00:00Z', lat: '41.95000', availableAt: 2 }),
        detection({ uid: 'm', acq: '2026-08-15T08:00:00Z', lat: '42.10000', availableAt: 1 }),
      ],
      { now: '2026-08-15T09:10:00Z' },
    );
    expect(result.assignments.map((assignment) => assignment.detectionUid)).toEqual([
      'm',
      'a',
      'z',
    ]);
    expect(result.state.clusters.map((cluster) => cluster.id)).toEqual([1, 2, 3]);
    expect(result.seeded.map((seed) => seed.clusterId)).toEqual([1, 2, 3]);
    expect(result.touched.map((touch) => touch.clusterId)).toEqual([1, 2, 3]);
    expect(result.state.takenPublicIds).toEqual([...result.state.takenPublicIds].sort());
  });

  it('sorts unattached rows by uid', () => {
    const result = run(
      [
        detection({ uid: 'z-geo', acq: '2026-08-15T09:00:00Z', lat: AT_41_90, source: SEVIRI }),
        detection({ uid: 'a-geo', acq: '2026-08-15T09:00:00Z', lat: '43.00000', source: SEVIRI }),
      ],
      { now: '2026-08-15T09:10:00Z' },
    );
    expect(result.unattached.map((row) => row.detectionUid)).toEqual(['a-geo', 'z-geo']);
  });

  it('keeps member lists in acquisition order regardless of arrival order', () => {
    const result = run(
      [
        detection({
          uid: 'late-arrival',
          acq: '2026-08-15T08:00:00Z',
          lat: AT_41_90,
          availableAt: epochMsFromIso('2026-08-15T09:30:00Z'),
        }),
        detection({
          uid: 'early-arrival',
          acq: '2026-08-15T09:00:00Z',
          lat: INSIDE_EPS,
          availableAt: epochMsFromIso('2026-08-15T09:05:00Z'),
        }),
      ],
      { now: '2026-08-15T09:40:00Z' },
    );
    expect(only(result.state.clusters).members.map((member) => member.detectionUid)).toEqual([
      'late-arrival',
      'early-arrival',
    ]);
  });
});

// ── A note the numbers above depend on ──────────────────────────────────────────────────

describe('the parameters these cases are calibrated against', () => {
  it('are the ones the boundary rows were chosen for', () => {
    // If a retune lands without this file being revisited, the boundary rows above stop
    // testing a boundary and start testing an interior point — silently, and still green.
    expect(CLUSTERING_PARAMS.values.tLinkHours * HOUR_MS).toBe(48 * HOUR_MS);
    expect(CLUSTERING_PARAMS.values.activeWindowHours * HOUR_MS).toBe(72 * HOUR_MS);
    expect(MINUTE_MS).toBe(60_000);
    const eps = CLUSTERING_PARAMS.values.epsBySource[VIIRS];
    expect(eps).toEqual({ kind: 'fixed', km: 1.25 });
    const inside = distanceKm({ lat: 41.9, lon: 23.5 }, { lat: 41.91125, lon: 23.5 }, metric);
    const outside = distanceKm({ lat: 41.9, lon: 23.5 }, { lat: 41.91126, lon: 23.5 }, metric);
    expect(inside).toBeLessThanOrEqual(1.25);
    expect(outside).toBeGreaterThan(1.25);
  });
});
