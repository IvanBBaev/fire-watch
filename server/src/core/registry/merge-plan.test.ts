import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { distanceKm, quantizeKm, type Coordinate } from '../clustering/geometry.js';
import type { Cluster, ClusterMember, ClusterMerge } from '../clustering/types.js';
import { epochMsFromIso } from '../ports/clock.js';
import { NO_ALIASES, type AliasLinks } from './alias-registry.js';
import type { AlertStateRow } from './alert-state.js';
import { buildMergePlan, type MergePlanInput } from './merge-plan.js';

const PARAMS = CLUSTERING_PARAMS.values;

interface MemberSpec {
  readonly uid: string;
  readonly lat: number;
  readonly lon: number;
  readonly acqTsIso?: string;
  readonly source?: ClusterMember['source'];
}

function member(spec: MemberSpec): ClusterMember {
  const acqTsIso = spec.acqTsIso ?? '2026-08-15T09:00:00Z';
  return {
    detectionUid: spec.uid,
    source: spec.source ?? 'firms:viirs:snpp',
    acqTsIso,
    acqTs: epochMsFromIso(acqTsIso),
    latCanonical: spec.lat.toFixed(5),
    lonCanonical: spec.lon.toFixed(5),
    coordinate: { lat: spec.lat, lon: spec.lon },
    epsKm: 1.25,
    footprintDefaulted: false,
  };
}

function cluster(spec: { id: number; publicId: string; members: readonly MemberSpec[] }): Cluster {
  const members = spec.members.map(member);
  const acqTimes = members.map((entry) => entry.acqTs);
  return {
    id: spec.id,
    publicId: spec.publicId,
    seedDetectionUid: members[0]?.detectionUid ?? 'seed',
    mintedAt: Math.min(...acqTimes),
    startedAt: Math.min(...acqTimes),
    lastDetectionAt: Math.max(...acqTimes),
    members,
    configVersion: CLUSTERING_PARAMS.version,
    sourceRegistryVersion: 'source_registry_v1',
  };
}

/** The diameter by definition — every pair, no hull involved. */
function widestKm(points: readonly Coordinate[]): number {
  let widest = 0;
  for (const a of points) {
    for (const b of points) {
      const km = distanceKm(a, b, PARAMS.metric);
      if (km > widest) widest = km;
    }
  }
  return widest;
}

function alertRow(
  overrides: Partial<AlertStateRow> & Pick<AlertStateRow, 'zoneId'>,
): AlertStateRow {
  return {
    eventPublicId: 'fw-2026-l1',
    state: 'none',
    escalationWatermark: 0,
    seededAtIso: null,
    lastNotifiedAtIso: null,
    ...overrides,
  };
}

function input(overrides: Partial<MergePlanInput>): MergePlanInput {
  return {
    merges: [],
    clusters: [],
    aliases: NO_ALIASES,
    alertStates: [],
    params: PARAMS,
    ...overrides,
  };
}

const MERGE: ClusterMerge = {
  survivorClusterId: 1,
  survivorPublicId: 'fw-2026-surv',
  absorbedClusterIds: [2, 3],
  absorbedPublicIds: ['fw-2026-l1', 'fw-2026-l2'],
  bridgedByDetectionUid: 'uid-bridge',
};

/** The post-batch survivor: its own members plus everything the two losers brought. */
const SURVIVOR_POINTS: readonly MemberSpec[] = [
  { uid: 'uid-a', lat: 41.9, lon: 23.5 },
  { uid: 'uid-b', lat: 41.92, lon: 23.5, acqTsIso: '2026-08-15T09:30:00Z' },
  {
    uid: 'uid-bridge',
    lat: 41.91,
    lon: 23.53,
    acqTsIso: '2026-08-15T10:00:00Z',
    source: 'firms:viirs:noaa20',
  },
];

const SURVIVOR = cluster({ id: 1, publicId: 'fw-2026-surv', members: SURVIVOR_POINTS });

describe('buildMergePlan — nothing to do', () => {
  it('returns the alias table it was given, unchanged and by identity', () => {
    // A batch with no merges is the overwhelmingly common case. Returning a rebuilt table
    // would make every batch write the whole registry back for no reason, and would make
    // "did this batch change identity" un-answerable by comparison.
    const aliases: AliasLinks = new Map([['fw-2026-old', 'fw-2026-new']]);
    const plan = buildMergePlan(input({ aliases }));

    expect(plan.aliases).toBe(aliases);
    expect(plan).toMatchObject({
      tombstones: [],
      aliasRewrites: [],
      detectionReattributions: [],
      survivors: [],
      alertStates: { upserts: [], deletes: [] },
    });
  });
});

describe('buildMergePlan — ADR-002 D3: tombstones, never deletions', () => {
  const plan = buildMergePlan(input({ merges: [MERGE], clusters: [SURVIVOR] }));

  it('turns every absorbed id into a tombstone pointing at the survivor', () => {
    expect(plan.tombstones).toEqual([
      {
        publicId: 'fw-2026-l1',
        mergedIntoPublicId: 'fw-2026-surv',
        bridgedByDetectionUid: 'uid-bridge',
      },
      {
        publicId: 'fw-2026-l2',
        mergedIntoPublicId: 'fw-2026-surv',
        bridgedByDetectionUid: 'uid-bridge',
      },
    ]);
  });

  it('records which detection bridged them — provenance for "why did this merge"', () => {
    // The one question a reviewer asks about a merge they disagree with. Without it the
    // answer is "re-run the batch and watch", which is not an answer at 3 a.m.
    expect(
      plan.tombstones.every((tombstone) => tombstone.bridgedByDetectionUid === 'uid-bridge'),
    ).toBe(true);
  });

  it("re-attributes the losers' detections to the survivor", () => {
    expect(plan.detectionReattributions).toEqual([
      { fromPublicId: 'fw-2026-l1', toPublicId: 'fw-2026-surv' },
      { fromPublicId: 'fw-2026-l2', toPublicId: 'fw-2026-surv' },
    ]);
  });

  it('leaves the alias table flat and resolvable', () => {
    expect([...plan.aliases.entries()].sort()).toEqual([
      ['fw-2026-l1', 'fw-2026-surv'],
      ['fw-2026-l2', 'fw-2026-surv'],
    ]);
    // Nothing existed before this batch, so there is nothing to shorten — the new rows are
    // inserts, and they are in `tombstones`.
    expect(plan.aliasRewrites).toEqual([]);
  });
});

describe('buildMergePlan — the survivor is recomputed, not combined', () => {
  const plan = buildMergePlan(input({ merges: [MERGE], clusters: [SURVIVOR] }));
  const survivor = plan.survivors[0];

  it('reports one survivor, identified both ways', () => {
    expect(plan.survivors).toHaveLength(1);
    expect(survivor).toMatchObject({ publicId: 'fw-2026-surv', clusterId: 1 });
  });

  it('recomputes the aggregates over the union of the members', () => {
    expect(survivor).toMatchObject({
      startedAtIso: '2026-08-15T09:00:00Z',
      lastDetectionAtIso: '2026-08-15T10:00:00Z',
      detectionCount: 3,
      centroidLatCanonical: '41.91000',
      centroidLonCanonical: '23.51000',
    });
  });

  it('sorts the source mix, because it ends up in canonical JSON', () => {
    expect(Object.keys(survivor?.sourceMix ?? {})).toEqual([
      'firms:viirs:noaa20',
      'firms:viirs:snpp',
    ]);
    expect(survivor?.sourceMix).toEqual({ 'firms:viirs:noaa20': 1, 'firms:viirs:snpp': 2 });
  });

  it('carries the hull as an open ring on the canonical grid', () => {
    expect(survivor?.hull).toEqual([
      { latCanonical: '41.90000', lonCanonical: '23.50000' },
      { latCanonical: '41.91000', lonCanonical: '23.53000' },
      { latCanonical: '41.92000', lonCanonical: '23.50000' },
    ]);
  });

  it('measures the diameter over the union, in whole quanta', () => {
    const expected = quantizeKm(
      widestKm(SURVIVOR_POINTS.map((spec) => ({ lat: spec.lat, lon: spec.lon }))),
      PARAMS.metric,
    );
    expect(survivor?.hullDiameterQuanta).toBe(expected);
    expect(Number.isInteger(survivor?.hullDiameterQuanta)).toBe(true);
  });

  it('does not flag a three-kilometre fire for review', () => {
    expect(survivor?.needsReview).toBe(false);
  });
});

describe('buildMergePlan — ADR-002 D4: the 20 km guardrail', () => {
  it('flags a survivor whose union is wider than the review threshold', () => {
    // No automatic split — D4 forbids it. What the merge does instead is admit that it may
    // have joined two fires, in the one field a human queue can be built on.
    const wide = cluster({
      id: 1,
      publicId: 'fw-2026-surv',
      members: [
        { uid: 'uid-a', lat: 41.9, lon: 23.5 },
        { uid: 'uid-bridge', lat: 42.05, lon: 23.5, acqTsIso: '2026-08-15T09:30:00Z' },
        { uid: 'uid-c', lat: 42.2, lon: 23.5, acqTsIso: '2026-08-15T10:00:00Z' },
      ],
    });
    const plan = buildMergePlan(input({ merges: [MERGE], clusters: [wide] }));

    expect(plan.survivors[0]?.needsReview).toBe(true);
    expect(plan.survivors[0]?.hullDiameterQuanta).toBeGreaterThan(
      quantizeKm(PARAMS.reviewHullDiameterKm, PARAMS.metric),
    );
  });

  it('stores no polygon for an event that is only a segment', () => {
    // Two detections have no interior. The adapter writes NULL rather than a degenerate
    // ring, and the diameter and the flag stay meaningful — they are what D4 reads.
    const segment = cluster({
      id: 1,
      publicId: 'fw-2026-surv',
      members: [
        { uid: 'uid-a', lat: 41.9, lon: 23.5 },
        { uid: 'uid-bridge', lat: 41.91, lon: 23.51, acqTsIso: '2026-08-15T09:30:00Z' },
      ],
    });
    const plan = buildMergePlan(input({ merges: [MERGE], clusters: [segment] }));

    expect(plan.survivors[0]?.hull).toHaveLength(2);
    expect(plan.survivors[0]?.needsReview).toBe(false);
  });
});

describe('buildMergePlan — chained merges inside one batch', () => {
  // `merges` is ordered by survivor cluster id, not by when the merges happened, so a
  // survivor that is itself absorbed later in the same batch can appear either way round.
  const first: ClusterMerge = {
    survivorClusterId: 2,
    survivorPublicId: 'fw-2026-mid',
    absorbedClusterIds: [3],
    absorbedPublicIds: ['fw-2026-l1'],
    bridgedByDetectionUid: 'uid-first',
  };
  const second: ClusterMerge = {
    survivorClusterId: 1,
    survivorPublicId: 'fw-2026-surv',
    absorbedClusterIds: [2],
    absorbedPublicIds: ['fw-2026-mid'],
    bridgedByDetectionUid: 'uid-second',
  };
  const forward = buildMergePlan(input({ merges: [first, second], clusters: [SURVIVOR] }));
  const backward = buildMergePlan(input({ merges: [second, first], clusters: [SURVIVOR] }));

  it('collapses the chain so every tombstone points at the final survivor', () => {
    expect(forward.tombstones).toEqual([
      {
        publicId: 'fw-2026-l1',
        mergedIntoPublicId: 'fw-2026-surv',
        bridgedByDetectionUid: 'uid-first',
      },
      {
        publicId: 'fw-2026-mid',
        mergedIntoPublicId: 'fw-2026-surv',
        bridgedByDetectionUid: 'uid-second',
      },
    ]);
  });

  it('produces the same plan whichever order the merges arrive in — I2', () => {
    expect(backward).toEqual(forward);
  });

  it("re-attributes the intermediate event's detections directly to the survivor", () => {
    // Not "l1 → mid → surv" applied in sequence. The adapter runs one UPDATE per row here,
    // and a two-step path would leave the rows on `mid` if the second step were reordered.
    expect(forward.detectionReattributions).toEqual([
      { fromPublicId: 'fw-2026-l1', toPublicId: 'fw-2026-surv' },
      { fromPublicId: 'fw-2026-mid', toPublicId: 'fw-2026-surv' },
    ]);
  });
});

describe('buildMergePlan — compressing a table that arrived chained', () => {
  it('reports the pointers it shortened, separately from the rows it inserted', () => {
    // An older tombstone pointing at an event that this batch has now absorbed. The row
    // still resolves either way; shortening it now is what keeps resolution O(1).
    const aliases: AliasLinks = new Map([['fw-2026-old', 'fw-2026-l1']]);
    const plan = buildMergePlan(input({ merges: [MERGE], clusters: [SURVIVOR], aliases }));

    expect(plan.aliasRewrites).toEqual([
      { publicId: 'fw-2026-old', from: 'fw-2026-l1', to: 'fw-2026-surv' },
    ]);
    // It is a rewrite, not an insert, and it is not a detection move: `fw-2026-old`'s rows
    // were re-attributed when *it* was absorbed.
    expect(plan.tombstones.map((tombstone) => tombstone.publicId)).toEqual([
      'fw-2026-l1',
      'fw-2026-l2',
    ]);
    expect(plan.detectionReattributions.map((move) => move.fromPublicId)).toEqual([
      'fw-2026-l1',
      'fw-2026-l2',
    ]);
    expect(plan.aliases.get('fw-2026-old')).toBe('fw-2026-surv');
  });
});

describe('buildMergePlan — the alert-state migration travels in the same plan', () => {
  it('moves a notified parent onto the survivor and clears the parent row — I3', () => {
    const plan = buildMergePlan(
      input({
        merges: [MERGE],
        clusters: [SURVIVOR],
        alertStates: [
          alertRow({
            zoneId: 'zone-blagoevgrad',
            eventPublicId: 'fw-2026-l1',
            state: 'notified_new',
            lastNotifiedAtIso: '2026-08-15T09:05:00Z',
          }),
        ],
      }),
    );

    expect(plan.alertStates.upserts).toEqual([
      {
        zoneId: 'zone-blagoevgrad',
        eventPublicId: 'fw-2026-surv',
        state: 'notified_new',
        escalationWatermark: 0,
        seededAtIso: null,
        lastNotifiedAtIso: '2026-08-15T09:05:00Z',
      },
    ]);
    // Left behind, the parent row is a second mouth: the next evaluation would find it and
    // send about a fire whose id no longer resolves to itself.
    expect(plan.alertStates.deletes).toEqual([
      { zoneId: 'zone-blagoevgrad', eventPublicId: 'fw-2026-l1' },
    ]);
  });

  it('takes the most advanced state across both losers and the survivor', () => {
    const plan = buildMergePlan(
      input({
        merges: [MERGE],
        clusters: [SURVIVOR],
        alertStates: [
          alertRow({ zoneId: 'z', eventPublicId: 'fw-2026-surv', state: 'notified_new' }),
          alertRow({
            zoneId: 'z',
            eventPublicId: 'fw-2026-l2',
            state: 'notified_escalation',
            escalationWatermark: 2,
          }),
          alertRow({ zoneId: 'z', eventPublicId: 'fw-2026-l1', state: 'none' }),
        ],
      }),
    );

    expect(plan.alertStates.upserts).toEqual([
      {
        zoneId: 'z',
        eventPublicId: 'fw-2026-surv',
        state: 'notified_escalation',
        escalationWatermark: 2,
        seededAtIso: null,
        lastNotifiedAtIso: null,
      },
    ]);
    expect(plan.alertStates.deletes).toEqual([
      { zoneId: 'z', eventPublicId: 'fw-2026-l1' },
      { zoneId: 'z', eventPublicId: 'fw-2026-l2' },
    ]);
  });

  it('ignores rows for events this merge does not touch', () => {
    // The adapter is allowed to load a generous set — every zone near the merge area —
    // without pre-filtering it through an alias table it would then be re-implementing.
    const plan = buildMergePlan(
      input({
        merges: [MERGE],
        clusters: [SURVIVOR],
        alertStates: [
          alertRow({ zoneId: 'z', eventPublicId: 'fw-2026-elsewhere', state: 'cooldown' }),
        ],
      }),
    );

    expect(plan.alertStates).toEqual({ upserts: [], deletes: [] });
  });

  it("leaves the survivor's own row in place rather than deleting and re-inserting it", () => {
    const plan = buildMergePlan(
      input({
        merges: [MERGE],
        clusters: [SURVIVOR],
        alertStates: [
          alertRow({ zoneId: 'z', eventPublicId: 'fw-2026-surv', state: 'notified_new' }),
        ],
      }),
    );

    expect(plan.alertStates.upserts).toHaveLength(1);
    expect(plan.alertStates.deletes).toEqual([]);
  });
});

describe('buildMergePlan — refusals', () => {
  it('refuses a survivor that is not in the working set', () => {
    // The merges and the state came from different batches. Any plan built on that pairing
    // would re-attribute detections onto an event that is no longer live.
    expect(() =>
      buildMergePlan(
        input({
          merges: [MERGE],
          clusters: [cluster({ id: 9, publicId: 'fw-2026-other', members: SURVIVOR_POINTS })],
        }),
      ),
    ).toThrow(/merge survivor fw-2026-surv is not in the working set/);
  });

  it('refuses a loser already merged into something else', () => {
    const aliases: AliasLinks = new Map([['fw-2026-l1', 'fw-2026-elsewhere']]);
    expect(() => buildMergePlan(input({ merges: [MERGE], clusters: [SURVIVOR], aliases }))).toThrow(
      /already merged into fw-2026-elsewhere/,
    );
  });
});
