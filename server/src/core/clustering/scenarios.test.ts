/**
 * Synthetic stand-ins for the CI-1 fixture register (docs/GATES.md §1.1).
 *
 * The real S1–S16 fixtures are checked-in detection sets with an `expected.json` beside
 * them, owned by D5. This file does not create any of them — it encodes the *clustering
 * half* of the three fixtures D1 is answerable for, in code, so that the identity engine
 * can be shown to behave correctly before the fixture harness exists and so that the
 * eventual golden run has something to disagree with.
 *
 * Where a fixture asserts something D1 does not decide — a score, a status, an alert — the
 * boundary is stated in the test rather than faked. A stand-in that quietly asserted
 * "never becomes an event" by way of a scoring rule this task does not own would be a test
 * that passes for the wrong reason and stops the real fixture from being written.
 *
 * | Fixture | Asserts (GATES §1.1)                      | D1's half                            |
 * |---------|-------------------------------------------|--------------------------------------|
 * | S1      | one cross-border cluster = one event       | all of it — this is D1               |
 * | S4      | never becomes an event (hard override, 0)  | one stable id to suppress, not many  |
 * | S5      | stays Unverified, no alert                 | count 1, one source, no corroboration|
 */

import type { SourceId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { clusterCentroid, sourceMix } from './aggregates.js';
import { CLUSTERING_PARAMS } from './clustering-params.js';
import { clusterBatch, emptyState } from './engine.js';
import type { ClusterBatchResult, ClusteringDetection, ClusteringState } from './types.js';

const VIIRS = 'firms:viirs:snpp';
const NOAA20 = 'firms:viirs:noaa20';
const SEVIRI = 'lsasaf:seviri:frp-pixel';

const HOUR_MS = 3_600_000;

interface Spec {
  readonly uid: string;
  readonly acq: string;
  readonly lat: string;
  readonly lon: string;
  readonly source?: SourceId;
  readonly availableAt?: number;
}

function detection(spec: Spec): ClusteringDetection {
  return {
    detectionUid: spec.uid,
    source: spec.source ?? VIIRS,
    availableAt: spec.availableAt ?? epochMsFromIso(spec.acq),
    acqTsIso: spec.acq,
    latCanonical: spec.lat,
    lonCanonical: spec.lon,
    scanKm: null,
    trackKm: null,
  };
}

function run(
  detections: readonly ClusteringDetection[],
  now: string,
  state: ClusteringState = emptyState(),
): ClusterBatchResult {
  return clusterBatch({
    detections,
    state,
    now: epochMsFromIso(now),
    config: CLUSTERING_PARAMS,
  });
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const first = items[0];
  if (first === undefined) {
    throw new Error('unreachable: length was asserted');
  }
  return first;
}

/**
 * S1 — Slavyanka border-crossing.
 *
 * The ridge runs along the Bulgarian/Greek border near 41.39° N, 23.52° E. A fire on it is
 * one fire; the two states that share it are an administrative fact the engine has no
 * representation of, which is the point of the fixture.
 *
 * The realistic failure this guards is not a coordinate bug — it is the shape of the
 * ingest. FIRMS area downloads are fetched per country, so the northern rows and the
 * southern rows of one burn arrive in different requests, land in different batches, and
 * are separated by however long the second poll takes. Anything that keyed identity on the
 * request, the country, or the batch would produce two events with two public ids, two sets
 * of alerts, and a map showing two fires 3 km apart on the same ridge.
 */
describe('S1 stand-in — a fire on the Slavyanka ridge is one event, not one per country', () => {
  const LON = '23.52000';
  // A chain north to south across the border, 0.01° ≈ 1.111 km apart: each hop is inside
  // VIIRS ε (1.25 km) but the ends are 3.33 km apart, which is 2.7·ε. Single-link is what
  // makes this one cluster; a fixed radius around the seed would split it.
  const NORTH = [
    detection({ uid: 'bg-1', acq: '2026-08-15T00:24:00Z', lat: '41.40000', lon: LON }),
    detection({ uid: 'bg-2', acq: '2026-08-15T00:24:00Z', lat: '41.39000', lon: LON }),
  ];
  const SOUTH = [
    detection({ uid: 'gr-1', acq: '2026-08-15T00:24:00Z', lat: '41.38000', lon: LON }),
    detection({ uid: 'gr-2', acq: '2026-08-15T00:24:00Z', lat: '41.37000', lon: LON }),
  ];

  it('joins the two country downloads into a single event with a single public id', () => {
    const bulgarian = run(NORTH, '2026-08-15T00:40:00Z');
    const seed = only(bulgarian.seeded);

    // The Greek half arrives twelve minutes later, in its own request.
    const greek = run(SOUTH, '2026-08-15T00:52:00Z', bulgarian.state);

    const cluster = only(greek.state.clusters);
    expect(cluster.publicId).toBe(seed.publicId);
    expect(cluster.members.map((m) => m.detectionUid)).toEqual(['bg-1', 'bg-2', 'gr-1', 'gr-2']);

    // Not a clean run of attachments, and deliberately not asserted as one. Canonical batch
    // order is (available_at, source, lat, lon), and every row of one download shares an
    // available_at — so the southern batch is processed from its far end inward. `gr-2`
    // (41.37) is 2.2 km from the Bulgarian cluster and seeds a second one; `gr-1` (41.38)
    // then sits within ε of both and unions them. The transient split is invisible outside
    // the batch, and the id that survives is the one already published.
    expect(only(greek.seeded).seedDetectionUid).toBe('gr-2');
    expect(only(greek.merges)).toMatchObject({
      survivorPublicId: seed.publicId,
      absorbedClusterIds: [2],
      bridgedByDetectionUid: 'gr-1',
    });
  });

  it('produces the same one event whichever country is polled first', () => {
    const greekFirst = run(SOUTH, '2026-08-15T00:40:00Z');
    const then = run(NORTH, '2026-08-15T00:52:00Z', greekFirst.state);

    const cluster = only(then.state.clusters);
    expect(cluster.members).toHaveLength(4);
    // Sorted by acquisition, not by arrival — the batch that came second is interleaved
    // into the member list rather than appended to it.
    expect(cluster.members.map((m) => m.detectionUid)).toEqual(['bg-1', 'bg-2', 'gr-1', 'gr-2']);
  });

  it('actually crosses the border, so the scenario is the one it claims to be', () => {
    // Without this the test above would still pass over four points on one side, and the
    // fixture it stands in for would be asserting nothing.
    const result = run([...NORTH, ...SOUTH], '2026-08-15T00:40:00Z');
    const cluster = only(result.state.clusters);
    const latitudes = cluster.members.map((m) => m.coordinate.lat);
    expect(Math.min(...latitudes)).toBeLessThan(41.39);
    expect(Math.max(...latitudes)).toBeGreaterThan(41.39);
    // The centroid sits on the border itself: an event that belongs to neither country's
    // list and to both, which is what the downstream zone matching has to cope with.
    expect(clusterCentroid(cluster).lat).toBeCloseTo(41.385, 5);
  });

  it('still merges the halves when a later detection bridges them, rather than growing a twin', () => {
    // The unlucky ordering: the two country downloads are far enough apart in time that the
    // southern rows are polled before anything links them, so two clusters exist for a
    // while. The row that finally lands between them must union the two events, not pick
    // one — otherwise the ridge carries a permanent duplicate.
    // 41.40 and 41.38 are 2.22 km apart — outside ε, so two events exist for half an hour.
    const north = run([NORTH[0] as ClusteringDetection], '2026-08-15T00:40:00Z');
    const south = run([SOUTH[0] as ClusteringDetection], '2026-08-15T00:52:00Z', north.state);
    expect(south.state.clusters).toHaveLength(2);

    const bridge = run(
      [detection({ uid: 'bg-3', acq: '2026-08-15T01:12:00Z', lat: '41.39000', lon: LON })],
      '2026-08-15T01:30:00Z',
      south.state,
    );
    const merge = only(bridge.merges);
    expect(merge.absorbedClusterIds).toEqual([2]);
    expect(bridge.state.clusters).toHaveLength(1);
    expect(only(bridge.state.clusters).publicId).toBe(merge.survivorPublicId);
  });
});

/**
 * S4 — Industrial static source.
 *
 * The fixture's assertion — "never becomes an event (hard override, score 0)" — is **not
 * D1's**. Identity has no opinion about what a hotspot is; suppressing a known industrial
 * site is the static-source mask on the scoring side, and building it into clustering
 * would mean a mask update silently rewrote which detections belong to which event.
 *
 * What D1 owes that override is a target it can hold onto. A flare stack detected every
 * night for a fortnight must be *one* event whose id never changes, because the mask, the
 * quarantine list and the operator's "yes, this is the refinery" are all keyed on an id.
 * If each night produced a fresh public id, a hard override would suppress last night's
 * fire and let tonight's through, for ever.
 */
describe('S4 stand-in — a static industrial source is one recurring event, not one per night', () => {
  const SITE = { lat: '42.10000', lon: '24.70000' } as const;
  const NIGHTS = 14;

  function nightly(): { readonly result: ClusterBatchResult; readonly publicIds: string[] } {
    let state = emptyState();
    let result: ClusterBatchResult | null = null;
    const publicIds: string[] = [];
    for (let night = 0; night < NIGHTS; night += 1) {
      const day = String(1 + night).padStart(2, '0');
      const acq = `2026-08-${day}T00:24:00Z`;
      result = run(
        [
          detection({
            uid: `flare-${String(night)}`,
            acq,
            lat: SITE.lat,
            lon: SITE.lon,
            source: night % 2 === 0 ? VIIRS : NOAA20,
          }),
        ],
        `2026-08-${day}T00:40:00Z`,
        state,
      );
      state = result.state;
      for (const cluster of state.clusters) {
        publicIds.push(cluster.publicId);
      }
    }
    if (result === null) {
      throw new Error('unreachable: NIGHTS is positive');
    }
    return { result, publicIds };
  }

  it('keeps one id across a fortnight of nightly repeats', () => {
    const { result, publicIds } = nightly();
    const cluster = only(result.state.clusters);
    expect(cluster.members).toHaveLength(NIGHTS);
    expect(new Set(publicIds).size).toBe(1);
    expect(publicIds[0]).toBe(cluster.publicId);
    // One seed in fourteen batches. Anything higher and the override has a moving target.
    expect(result.state.nextClusterId).toBe(2);
  });

  it('reports a 24 h gap every night, which is what marks the repeat as a repeat', () => {
    // The signature the mask and the day-only-repeat quarantine (S10) are built on: the
    // same event, touched again, at a gap that is regular rather than the ragged
    // re-detection pattern of a spreading fire. D1's job is to report it, not to judge it.
    let state = emptyState();
    const gaps: number[] = [];
    for (let night = 0; night < 3; night += 1) {
      const day = String(1 + night).padStart(2, '0');
      const result = run(
        [
          detection({
            uid: `flare-${String(night)}`,
            acq: `2026-08-${day}T00:24:00Z`,
            lat: SITE.lat,
            lon: SITE.lon,
          }),
        ],
        `2026-08-${day}T00:40:00Z`,
        state,
      );
      state = result.state;
      gaps.push(only(result.touched).gapMs);
    }
    expect(gaps).toEqual([0, 24 * HOUR_MS, 24 * HOUR_MS]);
  });

  it('would break into separate events if the site went quiet past T_LINK', () => {
    // Stated so the previous assertions are not read as a promise the engine cannot keep.
    // Nightly repeats stay one event because 24 h ≤ T_LINK; a site that stops for three
    // days and restarts is a new cluster, and it is D3's reignition link — not clustering —
    // that relates the two. A mask keyed on the id has to survive that, which is a
    // constraint on D6, not a bug here.
    const first = run(
      [detection({ uid: 'flare-a', acq: '2026-08-01T00:24:00Z', ...SITE })],
      '2026-08-01T00:40:00Z',
    );
    const later = run(
      [detection({ uid: 'flare-b', acq: '2026-08-04T00:24:00Z', ...SITE })],
      '2026-08-04T00:40:00Z',
      first.state,
    );
    expect(later.seeded).toHaveLength(1);
    expect(only(later.seeded).publicId).not.toBe(only(first.seeded).publicId);
  });
});

/**
 * S5 — Single-detection noise.
 *
 * The fixture asserts "stays Unverified, no alert". The status ladder and the alert
 * decision are ADR-004 and D4; D1 cannot assert either without inventing them.
 *
 * What D1 owes them is the evidence the verdict is computed from, and the guarantee that a
 * lone pixel is not quietly inflated into something that looks corroborated: one member,
 * one source, no second observation, and a centroid that is simply the pixel. The single
 * detection *does* become an event — promotion on creation is D2's rule, and an event at
 * Unverified is exactly how a lone pixel is meant to be represented — so the assertion here
 * is about its content, not its existence.
 */
describe('S5 stand-in — a lone detection is an event with nothing corroborating it', () => {
  const NOISE = { lat: '43.80000', lon: '25.95000' } as const;

  it('creates exactly one event holding exactly one detection from one source', () => {
    const result = run(
      [detection({ uid: 'noise-1', acq: '2026-08-15T00:24:00Z', ...NOISE })],
      '2026-08-15T00:40:00Z',
    );

    const cluster = only(result.state.clusters);
    expect(cluster.members).toHaveLength(1);
    expect(sourceMix(cluster)).toEqual({ [VIIRS]: 1 });
    expect(only(result.assignments).kind).toBe('seed');
    expect(only(result.touched)).toMatchObject({
      previousLastDetectionAtIso: null,
      gapMs: 0,
      attachedCount: 1,
      fineAttached: true,
    });
    expect(cluster.startedAt).toBe(cluster.lastDetectionAt);
    expect(clusterCentroid(cluster)).toEqual({ lat: 43.8, lon: 25.95 });
  });

  it('does not accumulate corroboration from unrelated noise elsewhere', () => {
    // Two isolated pixels 200 km apart are two lone detections, not a two-detection event.
    // The failure mode this guards is a candidate scan that falls back to "nearest cluster"
    // when nothing is within ε.
    const first = run(
      [detection({ uid: 'noise-1', acq: '2026-08-15T00:24:00Z', ...NOISE })],
      '2026-08-15T00:40:00Z',
    );
    const second = run(
      [
        detection({
          uid: 'noise-2',
          acq: '2026-08-15T02:24:00Z',
          lat: '42.00000',
          lon: '25.95000',
        }),
      ],
      '2026-08-15T02:40:00Z',
      first.state,
    );

    expect(second.seeded).toHaveLength(1);
    expect(second.state.clusters).toHaveLength(2);
    for (const cluster of second.state.clusters) {
      expect(cluster.members).toHaveLength(1);
    }
  });

  it('never lets a lone GEO pixel become an event at all (A1.5, CI-3)', () => {
    // The sharper version of the same scenario, and the one with an alert attached to it:
    // a single coarse pixel over an empty hillside is the cheapest possible false alarm.
    // Attach-only means it has nothing to attach to and no event is created.
    const result = run(
      [detection({ uid: 'geo-1', acq: '2026-08-15T00:24:00Z', ...NOISE, source: SEVIRI })],
      '2026-08-15T00:40:00Z',
    );

    expect(result.state.clusters).toEqual([]);
    expect(result.seeded).toEqual([]);
    expect(result.assignments).toEqual([]);
    expect(only(result.unattached)).toEqual({
      detectionUid: 'geo-1',
      source: SEVIRI,
      reason: 'coarse_no_candidate',
    });
  });
});
