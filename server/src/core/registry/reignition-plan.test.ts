/**
 * D3 — the reignition rule, boundary by boundary.
 *
 * Most of these are one comparison each, which is the point. Appendix A rule 3 says every
 * window in the identity and lifecycle paths is inclusive, and an off-by-one there is
 * invisible in production: the link is simply never written, nobody is notified twice
 * instead of once, and the only symptom is a map that shows two unrelated fires where a
 * person would have seen one story. So each bound is tested *at* the boundary, not near it.
 *
 * The clusters and candidates are built by hand rather than driven through the engine,
 * except in the S6 block at the end. Twelve days of synthetic detections to move one
 * timestamp would make the arithmetic under test the least visible thing in the file.
 */

import type { SourceId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { clusterBatch, emptyState } from '../clustering/engine.js';
import type { Coordinate } from '../clustering/geometry.js';
import type {
  Cluster,
  ClusterBatchResult,
  ClusteringDetection,
  ClusteringState,
  SeededCluster,
} from '../clustering/types.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type { ReignitionCandidateEvent } from '../ports/reignition-reader.js';
import { NO_ALIASES } from './alias-registry.js';
import type { AlertState, AlertStateRow } from './alert-state.js';
import {
  buildReignitionPlan,
  reignitionCandidateQuery,
  type ReignitionPlanInput,
} from './reignition-plan.js';

const PARAMS = CLUSTERING_PARAMS.values;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const VIIRS: SourceId = 'firms:viirs:snpp';

/** VIIRS ε, so the reignition radius is 2·1.25 = 2.5 km. */
const EPS_KM = 1.25;
const RADIUS_KM = EPS_KM * PARAMS.reignitionEpsMultiple;

const CHILD = 'fw-2026-child';
const SEED_START = epochMsFromIso('2026-08-20T00:00:00Z');

/** On the metric's reference parallel, so a north–south offset is a plain multiplication. */
const ORIGIN: Coordinate = { lat: PARAMS.metric.referenceLatDeg, lon: 25 };

/** `km` north of {@link ORIGIN}; exact enough that 1 mm quantisation decides the boundary. */
function northOf(km: number): Coordinate {
  return { lat: ORIGIN.lat + km / PARAMS.metric.kmPerDegreeLat, lon: ORIGIN.lon };
}

const SEED: SeededCluster = {
  clusterId: 7,
  publicId: CHILD,
  seedDetectionUid: 'seed-1',
  source: VIIRS,
  startedAtIso: '2026-08-20T00:00:00Z',
  coordinate: ORIGIN,
  epsKm: EPS_KM,
};

function liveCluster(
  id: number,
  publicId: string,
  at: Coordinate,
  startedAt: EpochMs,
  lastDetectionAt: EpochMs = startedAt,
): Cluster {
  return {
    id,
    publicId,
    seedDetectionUid: `${publicId}-seed`,
    mintedAt: startedAt,
    startedAt,
    lastDetectionAt,
    members: [
      {
        detectionUid: `${publicId}-seed`,
        source: VIIRS,
        acqTsIso: '2026-08-20T00:00:00Z',
        acqTs: startedAt,
        latCanonical: at.lat.toFixed(5),
        lonCanonical: at.lon.toFixed(5),
        coordinate: at,
        epsKm: EPS_KM,
        footprintDefaulted: false,
      },
    ],
    configVersion: CLUSTERING_PARAMS.version,
    sourceRegistryVersion: 'source_registry_v1',
  };
}

const CHILD_CLUSTER = liveCluster(SEED.clusterId, CHILD, ORIGIN, SEED_START);

interface CandidateSpec {
  readonly clusterId: number;
  readonly publicId: string;
  /** How long before the seed's first detection this event was last seen. */
  readonly gapMs: number;
  readonly km?: number;
  readonly startedAt?: EpochMs;
  readonly fuelBand?: ReignitionCandidateEvent['fuelBand'];
}

function candidate(spec: CandidateSpec): ReignitionCandidateEvent {
  return {
    clusterId: spec.clusterId,
    publicId: spec.publicId,
    centroid: northOf(spec.km ?? 1),
    startedAt: spec.startedAt ?? SEED_START - 30 * DAY_MS,
    lastDetectionAt: SEED_START - spec.gapMs,
    fuelBand: spec.fuelBand ?? null,
  };
}

function alertRow(
  zoneId: string,
  eventPublicId: string,
  state: AlertState,
  escalationWatermark = 0,
): AlertStateRow {
  return {
    zoneId,
    eventPublicId,
    state,
    escalationWatermark,
    seededAtIso: null,
    lastNotifiedAtIso: null,
  };
}

function planInput(overrides: Partial<ReignitionPlanInput> = {}): ReignitionPlanInput {
  return {
    seeded: [SEED],
    candidates: [],
    clusters: [CHILD_CLUSTER],
    aliases: NO_ALIASES,
    alertStates: [],
    params: PARAMS,
    ...overrides,
  };
}

describe('reignitionCandidateQuery — the widest read the rule can still be filtered out of', () => {
  it('asks for the longest fuel window and stops at T_LINK', () => {
    // 21 d and 48 h under `clustering_params_v1`. Widest, because the reader has no fuel
    // band to key the real window on; T_LINK, because anything closer in time was the
    // engine's decision and this pass may not revisit it.
    expect(reignitionCandidateQuery(SEED, PARAMS)).toEqual({
      at: ORIGIN,
      radiusKm: RADIUS_KM,
      notBefore: SEED_START - 21 * DAY_MS,
      notAfter: SEED_START - 48 * HOUR_MS,
    });
  });
});

describe('D3 — eligibility', () => {
  it('plans nothing when the batch seeded nothing', () => {
    const plan = buildReignitionPlan(planInput({ seeded: [] }));
    expect(plan).toEqual({ links: [], alertStateUpserts: [] });
  });

  it('plans nothing when no past event is in reach', () => {
    expect(buildReignitionPlan(planInput()).links).toEqual([]);
  });

  it('writes no link at exactly T_LINK — the boundary instant belongs to attach', () => {
    // Appendix A rule 3 makes `Δt ≤ T_LINK` an attach, so reignition is its strict
    // complement. A candidate this close that the engine did not attach to is a different
    // fire burning beside a live one, and the ADR gives that no relation at all.
    const plan = buildReignitionPlan(
      planInput({
        candidates: [candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 48 * HOUR_MS })],
      }),
    );
    expect(plan.links).toEqual([]);
  });

  it('writes a link one minute past T_LINK', () => {
    const plan = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 48 * HOUR_MS + 60_000 }),
        ],
      }),
    );
    expect(plan.links).toEqual([
      {
        clusterId: SEED.clusterId,
        publicId: CHILD,
        relatedClusterId: 1,
        relatedPublicId: 'fw-2026-old',
        relationKind: 'possible_reignition',
        gapMs: 48 * HOUR_MS + 60_000,
        distanceQuanta: 1_000_000,
        windowDays: 14,
        fuelBand: null,
      },
    ]);
  });

  it('writes a link at exactly the fuel window and none one millisecond later', () => {
    const at = buildReignitionPlan(
      planInput({
        candidates: [candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 14 * DAY_MS })],
      }),
    );
    expect(at.links).toHaveLength(1);

    const past = buildReignitionPlan(
      planInput({
        candidates: [candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 14 * DAY_MS + 1 })],
      }),
    );
    expect(past.links).toEqual([]);
  });

  it('writes a link at exactly 2·ε and none ten metres further out', () => {
    const at = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 3 * DAY_MS, km: RADIUS_KM }),
        ],
      }),
    );
    expect(at.links).toHaveLength(1);
    expect(at.links[0]?.distanceQuanta).toBe(2_500_000);

    const past = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({
            clusterId: 1,
            publicId: 'fw-2026-old',
            gapMs: 3 * DAY_MS,
            km: RADIUS_KM + 0.01,
          }),
        ],
      }),
    );
    expect(past.links).toEqual([]);
  });

  it('keys the window on the parent, not on the new fire', () => {
    // The window is a statement about what was burning and how much of it — a grass fire is
    // out in a week, a duff layer under conifers is not. The new cluster is a handful of
    // pixels hours old and knows neither, so the band travels with the candidate.
    const grass = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({
            clusterId: 1,
            publicId: 'fw-2026-old',
            gapMs: 10 * DAY_MS,
            fuelBand: 'grass',
          }),
        ],
      }),
    );
    expect(grass.links).toEqual([]);

    const forest = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({
            clusterId: 1,
            publicId: 'fw-2026-old',
            gapMs: 20 * DAY_MS,
            fuelBand: 'forest',
          }),
        ],
      }),
    );
    expect(forest.links[0]).toMatchObject({ windowDays: 21, fuelBand: 'forest' });
  });

  it('gives an unclassified parent the middle band, never the shortest (rule 5)', () => {
    // The band nothing has classified yet — which today is every band, since `fire_events`
    // has no land cover and the classifier is not built. Rule 5 picks 14 d deliberately:
    // 7 d would silently drop real links and 21 d would relate fires that are not related.
    const plan = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 10 * DAY_MS, fuelBand: null }),
        ],
      }),
    );
    expect(plan.links[0]).toMatchObject({ windowDays: 14, fuelBand: null });
  });
});

describe('D3 — choosing exactly one parent (Appendix A rule 2)', () => {
  const eligible = { gapMs: 5 * DAY_MS, km: 1 } as const;

  it('prefers the nearest centroid to the new cluster', () => {
    const plan = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({ clusterId: 1, publicId: 'fw-2026-far', gapMs: eligible.gapMs, km: 2 }),
          candidate({ clusterId: 2, publicId: 'fw-2026-near', gapMs: eligible.gapMs, km: 0.5 }),
        ],
      }),
    );
    expect(plan.links[0]?.relatedPublicId).toBe('fw-2026-near');
  });

  it('breaks an equidistant tie on the older start, then on the lower cluster id', () => {
    const older = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({
            clusterId: 1,
            publicId: 'fw-2026-a',
            ...eligible,
            startedAt: SEED_START - 20 * DAY_MS,
          }),
          candidate({
            clusterId: 2,
            publicId: 'fw-2026-b',
            ...eligible,
            startedAt: SEED_START - 25 * DAY_MS,
          }),
        ],
      }),
    );
    expect(older.links[0]?.relatedPublicId).toBe('fw-2026-b');

    const sameStart = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({ clusterId: 9, publicId: 'fw-2026-a', ...eligible }),
          candidate({ clusterId: 4, publicId: 'fw-2026-b', ...eligible }),
        ],
      }),
    );
    expect(sameStart.links[0]?.relatedPublicId).toBe('fw-2026-b');
  });

  it('writes one link even when three candidates qualify', () => {
    // "Exactly one `related_event_id` is written" — the UI sentence has room for one
    // predecessor, and a second row would make the choice the reader's problem.
    const plan = buildReignitionPlan(
      planInput({
        candidates: [
          candidate({ clusterId: 1, publicId: 'fw-2026-a', gapMs: 3 * DAY_MS, km: 2 }),
          candidate({ clusterId: 2, publicId: 'fw-2026-b', gapMs: 4 * DAY_MS, km: 1 }),
          candidate({ clusterId: 3, publicId: 'fw-2026-c', gapMs: 5 * DAY_MS, km: 2.4 }),
        ],
      }),
    );
    expect(plan.links).toHaveLength(1);
    expect(plan.links[0]?.relatedPublicId).toBe('fw-2026-b');
  });

  it('does not care what order the reader returned the candidates in', () => {
    const rows = [
      candidate({ clusterId: 1, publicId: 'fw-2026-a', gapMs: 3 * DAY_MS, km: 2 }),
      candidate({ clusterId: 2, publicId: 'fw-2026-b', gapMs: 4 * DAY_MS, km: 1 }),
      candidate({ clusterId: 3, publicId: 'fw-2026-c', gapMs: 5 * DAY_MS, km: 2.4 }),
    ];
    const forwards = buildReignitionPlan(planInput({ candidates: rows }));
    const backwards = buildReignitionPlan(planInput({ candidates: [...rows].reverse() }));
    expect(backwards).toEqual(forwards);
  });
});

describe('D3 — composition with the merge plan', () => {
  const SURVIVOR = 'fw-2026-survivor';
  const survivorCluster = liveCluster(3, SURVIVOR, ORIGIN, SEED_START);

  it('writes the relation against the id the seed was absorbed into', () => {
    // The seed is minted, then a later detection in the same batch bridges it into an
    // existing cluster. A relation written against the seed's own id would point at a
    // tombstone the API redirects away from.
    const plan = buildReignitionPlan(
      planInput({
        clusters: [survivorCluster],
        aliases: new Map([[CHILD, SURVIVOR]]),
        candidates: [candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 5 * DAY_MS })],
      }),
    );
    expect(plan.links[0]).toMatchObject({ clusterId: 3, publicId: SURVIVOR });
  });

  it('never relates an event to itself when the batch merged it with its own candidate', () => {
    // The 48–72 h band: the old event is still in the working set, a bridging detection
    // unions the two, and the merge is direct evidence they are one fire — strictly better
    // evidence than the hedge this module writes. The database refuses the self-link
    // (`fire_events_related_not_self`); it should never get the chance.
    const plan = buildReignitionPlan(
      planInput({
        clusters: [liveCluster(1, 'fw-2026-old', ORIGIN, SEED_START - 6 * DAY_MS, SEED_START)],
        aliases: new Map([[CHILD, 'fw-2026-old']]),
        candidates: [candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 5 * DAY_MS })],
      }),
    );
    expect(plan.links).toEqual([]);
  });

  it('measures the gap against the working set, not against the stale read', () => {
    // The reader ran before the batch. A candidate that received a detection in it was last
    // seen minutes ago, not days — and a stale gap is the one number that turns a
    // continuation into a reignition claim about a fire that never stopped burning.
    const stale = candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 5 * DAY_MS });
    const plan = buildReignitionPlan(
      planInput({
        clusters: [
          CHILD_CLUSTER,
          liveCluster(1, 'fw-2026-old', northOf(1), SEED_START - 6 * DAY_MS, SEED_START - HOUR_MS),
        ],
        candidates: [stale],
      }),
    );
    expect(plan.links).toEqual([]);
  });

  it('refuses to plan against an event this batch never produced', () => {
    expect(() =>
      buildReignitionPlan(
        planInput({
          clusters: [],
          candidates: [candidate({ clusterId: 1, publicId: 'fw-2026-old', gapMs: 5 * DAY_MS })],
        }),
      ),
    ).toThrow(RangeError);
  });
});

describe('D3 — alert inheritance (ADR-004 A1.6)', () => {
  const OLD = 'fw-2026-old';
  const linked = { candidates: [candidate({ clusterId: 1, publicId: OLD, gapMs: 5 * DAY_MS })] };

  it("carries the predecessor's most advanced state onto the new event", () => {
    // The whole reason the link is written at all. Without this the zone that was told
    // "no longer detected" on the 15th is told "new fire" on the 20th about the same
    // hillside, and the type is decided on the parent chain, not on the event id.
    const plan = buildReignitionPlan(
      planInput({
        ...linked,
        alertStates: [alertRow('zone-a', OLD, 'notified_new', 3)],
      }),
    );
    expect(plan.alertStateUpserts).toEqual([alertRow('zone-a', CHILD, 'notified_new', 3)]);
  });

  it('leaves the predecessor its own rows — inheritance is a copy, not a move', () => {
    // Unlike a merge loser, the parent is still a live event with its own history. Moving
    // its state would leave the zone with no record of the fire it was actually notified
    // about, which is why the plan has no delete list at all.
    const plan = buildReignitionPlan(
      planInput({ ...linked, alertStates: [alertRow('zone-a', OLD, 'notified_escalation', 2)] }),
    );
    expect(Object.keys(plan)).toEqual(['links', 'alertStateUpserts']);
    expect(plan.alertStateUpserts.every((row) => row.eventPublicId === CHILD)).toBe(true);
  });

  it('takes the more advanced of the two when the new event already has a row', () => {
    const plan = buildReignitionPlan(
      planInput({
        ...linked,
        alertStates: [
          alertRow('zone-a', OLD, 'notified_new', 5),
          alertRow('zone-a', CHILD, 'none', 0),
        ],
      }),
    );
    expect(plan.alertStateUpserts).toEqual([alertRow('zone-a', CHILD, 'notified_new', 5)]);
  });

  it('inherits nothing when the predecessor was never notified anywhere', () => {
    const plan = buildReignitionPlan(planInput(linked));
    expect(plan.links).toHaveLength(1);
    expect(plan.alertStateUpserts).toEqual([]);
  });

  it('folds every predecessor even though only one of them is named in the link', () => {
    // Two seeds absorbed into one survivor. The relation is a sentence shown to a person
    // and rule 2 allows one; the inheritance is a promise not to shout twice and has to
    // union over both, or the zone notified about the parent that lost the tie-break gets a
    // `new_fire` about the survivor.
    const second: SeededCluster = {
      ...SEED,
      clusterId: 9,
      publicId: 'fw-2026-second',
      seedDetectionUid: 'seed-2',
      coordinate: northOf(40),
    };
    const plan = buildReignitionPlan(
      planInput({
        seeded: [SEED, second],
        clusters: [CHILD_CLUSTER],
        aliases: new Map([[second.publicId, CHILD]]),
        candidates: [
          candidate({ clusterId: 1, publicId: OLD, gapMs: 5 * DAY_MS }),
          {
            ...candidate({ clusterId: 2, publicId: 'fw-2026-other', gapMs: 5 * DAY_MS }),
            centroid: northOf(40.5),
          },
        ],
        alertStates: [
          alertRow('zone-b', 'fw-2026-other', 'notified_escalation', 4),
          alertRow('zone-a', OLD, 'notified_new', 1),
        ],
      }),
    );

    expect(plan.links).toHaveLength(1);
    expect(plan.links[0]).toMatchObject({ publicId: CHILD, relatedPublicId: OLD });
    expect(plan.alertStateUpserts).toEqual([
      alertRow('zone-a', CHILD, 'notified_new', 1),
      alertRow('zone-b', CHILD, 'notified_escalation', 4),
    ]);
  });

  it('ignores rows belonging to events outside the family', () => {
    const plan = buildReignitionPlan(
      planInput({
        ...linked,
        alertStates: [
          alertRow('zone-a', 'fw-2026-unrelated', 'notified_new', 9),
          alertRow('zone-a', OLD, 'notified_new', 1),
        ],
      }),
    );
    expect(plan.alertStateUpserts).toEqual([alertRow('zone-a', CHILD, 'notified_new', 1)]);
  });
});

describe('D3 — I5 determinism', () => {
  it('gives byte-identical plans for the same input twice', () => {
    const input = planInput({
      candidates: [
        candidate({ clusterId: 1, publicId: 'fw-2026-a', gapMs: 3 * DAY_MS, km: 2 }),
        candidate({ clusterId: 2, publicId: 'fw-2026-b', gapMs: 4 * DAY_MS, km: 1 }),
      ],
      alertStates: [alertRow('zone-a', 'fw-2026-b', 'notified_new', 2)],
    });
    expect(JSON.stringify(buildReignitionPlan(input))).toBe(
      JSON.stringify(buildReignitionPlan(input)),
    );
  });
});

/**
 * S6 — Megafire cooling + reignition (GATES §1.1).
 *
 * The fixture asserts three things: the fuel-window relation, no false `no_longer_detected`,
 * and that the FER is not charged. The middle one is D4's and the last one is D6's; what
 * D1 and D3 own together is the first, and it is the half that has to be true before the
 * other two can be written.
 *
 * Driven through the engine rather than hand-built, because the interesting part is the
 * handover: the old event has to fall out of the working set before the new detection
 * arrives, or it would simply attach and there would be nothing to relate.
 */
describe('S6 stand-in — a fire that reignites twelve days later is a new event pointing back', () => {
  const LON = '24.50000';
  const BURN = ['41.90000', '41.91000', '41.92000'];

  function burn(): { readonly state: ClusteringState; readonly cluster: Cluster } {
    let state = emptyState();
    let result: ClusterBatchResult | null = null;
    for (const [index, lat] of BURN.entries()) {
      const day = String(1 + index).padStart(2, '0');
      result = clusterBatch({
        detections: [
          {
            detectionUid: `burn-${String(index)}`,
            source: VIIRS,
            availableAt: epochMsFromIso(`2026-08-${day}T00:24:00Z`),
            acqTsIso: `2026-08-${day}T00:24:00Z`,
            latCanonical: lat,
            lonCanonical: LON,
            scanKm: null,
            trackKm: null,
          } satisfies ClusteringDetection,
        ],
        state,
        now: epochMsFromIso(`2026-08-${day}T00:40:00Z`),
        config: CLUSTERING_PARAMS,
      });
      state = result.state;
    }
    const cluster = result?.state.clusters[0];
    if (cluster === undefined) throw new Error('unreachable: the burn seeded a cluster');
    return { state, cluster };
  }

  /** The old event as the registry stores it, which is where D3 reads it back from. */
  function asCandidate(cluster: Cluster): ReignitionCandidateEvent {
    return {
      clusterId: cluster.id,
      publicId: cluster.publicId,
      centroid: { lat: 41.91, lon: 24.5 },
      startedAt: cluster.startedAt,
      lastDetectionAt: cluster.lastDetectionAt,
      fuelBand: null,
    };
  }

  /** 2 km north of the old centroid: inside 2·ε, twelve days after the last detection. */
  const RESTART: ClusteringDetection = {
    detectionUid: 'restart-1',
    source: VIIRS,
    availableAt: epochMsFromIso('2026-08-15T00:24:00Z'),
    acqTsIso: '2026-08-15T00:24:00Z',
    latCanonical: '41.92800',
    lonCanonical: LON,
    scanKm: null,
    trackKm: null,
  };

  it('evicts the cooled event and seeds a new one instead of attaching to it', () => {
    const { state, cluster } = burn();
    expect(cluster.members).toHaveLength(3);

    const restart = clusterBatch({
      detections: [RESTART],
      state,
      now: epochMsFromIso('2026-08-15T00:40:00Z'),
      config: CLUSTERING_PARAMS,
    });

    expect(restart.evictedClusterIds).toEqual([cluster.id]);
    expect(restart.seeded).toHaveLength(1);
    expect(restart.seeded[0]?.publicId).not.toBe(cluster.publicId);
  });

  it('relates the two through the fuel window and inherits the alert state', () => {
    const { state, cluster } = burn();
    const restart = clusterBatch({
      detections: [RESTART],
      state,
      now: epochMsFromIso('2026-08-15T00:40:00Z'),
      config: CLUSTERING_PARAMS,
    });

    const plan = buildReignitionPlan({
      seeded: restart.seeded,
      candidates: [asCandidate(cluster)],
      clusters: restart.state.clusters,
      aliases: NO_ALIASES,
      alertStates: [alertRow('zone-smolyan', cluster.publicId, 'notified_new', 1)],
      params: PARAMS,
    });

    const link = plan.links[0];
    expect(link).toMatchObject({
      publicId: restart.seeded[0]?.publicId,
      relatedPublicId: cluster.publicId,
      relationKind: 'possible_reignition',
      gapMs: 12 * DAY_MS,
      windowDays: 14,
      fuelBand: null,
    });
    expect(link?.distanceQuanta).toBeLessThanOrEqual(2_500_000);

    // A1.6: the zone that was notified about the first burn is already at `notified_new` on
    // the new event, so the alert decision reads `escalation` off the row rather than
    // walking the chain. Asserting the *type* is D4's half of this fixture.
    expect(plan.alertStateUpserts).toEqual([
      alertRow('zone-smolyan', restart.seeded[0]?.publicId ?? '', 'notified_new', 1),
    ]);
  });

  it('writes no relation once the fire has been out past the window', () => {
    // The third branch of the rule, and the one that keeps the map honest: past the window
    // this is simply a different fire on ground that burned once before.
    const { state, cluster } = burn();
    const late: ClusteringDetection = {
      ...RESTART,
      availableAt: epochMsFromIso('2026-09-01T00:24:00Z'),
      acqTsIso: '2026-09-01T00:24:00Z',
    };
    const restart = clusterBatch({
      detections: [late],
      state,
      now: epochMsFromIso('2026-09-01T00:40:00Z'),
      config: CLUSTERING_PARAMS,
    });

    const plan = buildReignitionPlan({
      seeded: restart.seeded,
      candidates: [asCandidate(cluster)],
      clusters: restart.state.clusters,
      aliases: NO_ALIASES,
      alertStates: [alertRow('zone-smolyan', cluster.publicId, 'notified_new', 1)],
      params: PARAMS,
    });

    expect(plan).toEqual({ links: [], alertStateUpserts: [] });
  });
});
