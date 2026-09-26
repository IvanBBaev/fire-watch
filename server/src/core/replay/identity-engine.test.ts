/**
 * The identity engine under replay (D5; gates CI-1, CI-2).
 *
 * The fixtures under `server/fixtures/` assert *outcomes* — one event, a survivor, a
 * tombstone — and they assert them through the loader, which needs a filesystem. These
 * tests assert the three pieces of bookkeeping that sit between `clusterBatch` and the
 * report and that no fixture can isolate: that an evicted cluster is still reported and
 * still offered as a reignition parent, that a merge loser becomes a tombstone rather
 * than a hole, and that the pinned parameter versions are checked rather than decorative.
 *
 * Every distance below is computed on the engine's own planar metric rather than guessed.
 * At latitude 41.86 the pinned scale gives
 *
 *   km per degree of longitude = 81.936 + (41.86 - 42.7) x (-1.3146) = 83.040264
 *
 * so 0.005 deg is 0.415 km, 0.015 deg is 1.246 km — just inside the 1.25 km VIIRS
 * epsilon — and 0.03 deg is 2.491 km, comfortably outside it. Those three numbers are
 * what make the scenarios below say what they claim to say, and a retune of the metric
 * that invalidates them should fail here loudly rather than quietly stop testing merges.
 */

import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import type { ClusteringConfig } from '../clustering/types.js';
import { defineConfig } from '../config/versioned-config.js';
import type { CloudCoverSample } from '../lifecycle/types.js';
import {
  EMPTY_OBSERVATIONS,
  parseFixtureManifest,
  parseReplayBatch,
  type ObservationContext,
} from './fixture-format.js';
import { identityEngine } from './identity-engine.js';
import { runReplay, type ReplayEvent, type ReplayFixture, type ReplayReport } from './runner.js';

/** A syntactically valid detection uid. The digest is only verified by the loader. */
const uid = (n: number): string => String(n).padStart(64, '0');

const PINNED = Object.freeze({
  clustering_params: 'clustering_params_v1',
  lifecycle_params: 'lifecycle_params_v1',
  pass_table: 'pass_table_v0',
  score_params: 'score_params_v0',
  sources: 'source_registry_v1',
});

/** The four the engine insists on; the source registry is the one it merely checks. */
const REQUIRED_PINS = Object.freeze({
  clustering_params: 'clustering_params_v1',
  lifecycle_params: 'lifecycle_params_v1',
  pass_table: 'pass_table_v0',
  score_params: 'score_params_v0',
});

interface DetectionSpec {
  readonly n: number;
  readonly acq: string;
  readonly lat?: string;
  readonly lon: string;
}

interface BatchSpec {
  readonly name: string;
  readonly availableAt: string;
  readonly detections: readonly DetectionSpec[];
}

interface FixtureSpec {
  readonly clockStart: string;
  readonly configVersions?: Readonly<Record<string, string>>;
  readonly batches: readonly BatchSpec[];
}

function makeFixture(spec: FixtureSpec, observations: ObservationContext): ReplayFixture {
  const manifest = parseFixtureManifest(
    {
      id: 'T-identity',
      title: 'identity engine unit fixture',
      asserts: 'whatever the test around it asserts',
      required: 'suite',
      owner: 'WP2',
      engine: 'identity',
      clockStart: spec.clockStart,
      mode: 'live',
      allowRevive: false,
      configVersions: { ...(spec.configVersions ?? PINNED) },
      inputs: spec.batches.map((batch) => batch.name),
      expected: 'expected.json',
    },
    'T-identity/manifest.json',
  );

  return {
    manifest,
    batches: spec.batches.map((batch) =>
      parseReplayBatch(
        {
          availableAt: batch.availableAt,
          detections: batch.detections.map((detection) => ({
            detectionUid: uid(detection.n),
            source: 'firms:viirs:snpp',
            acqTsIso: detection.acq,
            latCanonical: detection.lat ?? '41.86000',
            lonCanonical: detection.lon,
            confidence: 'nominal',
            frpMw: 12.5,
            dayNight: 'N',
          })),
        },
        batch.name,
      ),
    ),
    expected: null,
    observations,
  };
}

/**
 * `observations` defaults to `EMPTY_OBSERVATIONS` because most of these tests are about
 * identity rather than about weather, and a fixture that declares no sky is the honest
 * shape for them: with no cloud sample covering an expected pass, nothing accumulates.
 * The lifecycle tests that need evidence to move pass their own context.
 */
function replay(
  spec: FixtureSpec,
  config?: ClusteringConfig,
  observations: ObservationContext = EMPTY_OBSERVATIONS,
): ReplayReport {
  return runReplay(
    makeFixture(spec, observations),
    identityEngine(config === undefined ? {} : { config }),
  );
}

/** Whole UTC hours of open sky from `fromIso`, so every expected pass counts in full. */
function hourlyClearSky(fromIso: string, hours: number): readonly CloudCoverSample[] {
  const startMs = Date.parse(fromIso);
  const samples: CloudCoverSample[] = [];
  for (let hour = 0; hour < hours; hour += 1) {
    samples.push({
      hourStartMs: startMs + hour * 3_600_000,
      percent: 0,
    });
  }
  return samples;
}

/** The one event matching `predicate`, or a failure naming how many there really were. */
function theOnly(
  events: readonly ReplayEvent[],
  predicate: (event: ReplayEvent) => boolean,
): ReplayEvent {
  const matches = events.filter(predicate);
  expect(matches).toHaveLength(1);
  const first = matches[0];
  if (first === undefined) throw new Error('unreachable: length was asserted above');
  return first;
}

/**
 * One detection, then a second one 5 days later 0.415 km away. The 123 h between the
 * polls is past the 72 h active window, so the first cluster leaves the working set and
 * the second detection seeds a new one; the 120 h between the *acquisitions* is past
 * T_LINK (48 h) but inside the 14-day window an unclassified fuel band falls into, and
 * 0.415 km is inside 2 x epsilon = 2.5 km.
 */
const reignition: FixtureSpec = {
  clockStart: '2026-08-04T03:00:00Z',
  batches: [
    {
      name: 'poll-01.json',
      availableAt: '2026-08-04T03:20:00Z',
      detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
    },
    {
      name: 'poll-02.json',
      availableAt: '2026-08-09T03:20:00Z',
      detections: [{ n: 2, acq: '2026-08-09T00:12:00Z', lon: '26.10500' }],
    },
  ],
};

/**
 * Two seeds 0.03 deg apart — 2.491 km, so two clusters — and then a detection halfway
 * between them, 1.246 km from each and therefore inside epsilon of both. The batch
 * unions them, and the absorbed public id has to keep existing (I1/I2).
 */
const merge: FixtureSpec = {
  clockStart: '2026-08-05T03:00:00Z',
  batches: [
    {
      name: 'poll-01.json',
      availableAt: '2026-08-05T03:10:00Z',
      detections: [
        { n: 1, acq: '2026-08-05T00:06:00Z', lon: '26.10000' },
        { n: 2, acq: '2026-08-05T00:06:00Z', lon: '26.13000' },
      ],
    },
    {
      name: 'poll-02.json',
      availableAt: '2026-08-05T14:00:00Z',
      detections: [{ n: 3, acq: '2026-08-05T12:00:00Z', lon: '26.11500' }],
    },
  ],
};

describe('pinned config versions', () => {
  const oneBatch = {
    clockStart: '2026-08-04T03:00:00Z',
    batches: [
      {
        name: 'poll-01.json',
        availableAt: '2026-08-04T03:20:00Z',
        detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
      },
    ],
  } as const;

  it('refuses a fixture that pins no parameter version', () => {
    expect(() =>
      replay({ ...oneBatch, configVersions: { sources: 'source_registry_v1' } }),
    ).toThrow(/does not pin "clustering_params"/);
  });

  it('refuses a fixture that pins clustering but not the lifecycle parameters', () => {
    expect(() =>
      replay({
        ...oneBatch,
        configVersions: { clustering_params: 'clustering_params_v1', pass_table: 'pass_table_v0' },
      }),
    ).toThrow(/does not pin "lifecycle_params"/);
  });

  it('refuses a fixture that pins no pass table', () => {
    // The table is a model of the constellation: without it pinned, a refit silently
    // changes which overpasses the recorded status was ever measured against.
    expect(() =>
      replay({
        ...oneBatch,
        configVersions: {
          clustering_params: 'clustering_params_v1',
          lifecycle_params: 'lifecycle_params_v1',
        },
      }),
    ).toThrow(/does not pin "pass_table"/);
  });

  it('refuses a fixture that pins no score parameters', () => {
    // Every reported event carries a bucket, and the bucket is a function of the ten §3.5
    // weights: a fixture replayed under refitted ones asserts nothing about the bucket it
    // recorded, which is exactly the silence this pin exists to break.
    expect(() =>
      replay({
        ...oneBatch,
        configVersions: {
          clustering_params: 'clustering_params_v1',
          lifecycle_params: 'lifecycle_params_v1',
          pass_table: 'pass_table_v0',
        },
      }),
    ).toThrow(/does not pin "score_params"/);
  });

  it('refuses a fixture authored against a different pass table', () => {
    expect(() =>
      replay({ ...oneBatch, configVersions: { ...REQUIRED_PINS, pass_table: 'pass_table_v1' } }),
    ).toThrow(/pins pass_table=pass_table_v1 but the replay runs pass_table_v0/);
  });

  it('refuses a fixture authored against a different parameter version', () => {
    expect(() =>
      replay({
        ...oneBatch,
        configVersions: { ...REQUIRED_PINS, clustering_params: 'clustering_params_v2' },
      }),
    ).toThrow(
      /pins clustering_params=clustering_params_v2 but the replay runs clustering_params_v1/,
    );
  });

  it('refuses a fixture authored against a different source registry', () => {
    expect(() =>
      replay({
        ...oneBatch,
        configVersions: { ...PINNED, sources: 'source_registry_v2' },
      }),
    ).toThrow(/pins sources=source_registry_v2/);
  });

  it('accepts a fixture that pins the parameters and stays silent about the registry', () => {
    const report = replay({ ...oneBatch, configVersions: { ...REQUIRED_PINS } });
    expect(report.events).toHaveLength(1);
  });

  it('replays under the parameter set it was handed, not a module default', () => {
    // Same values, different version: the only thing that changes is which fixtures the
    // engine will accept, which is exactly what the `config` option is for.
    const v2: ClusteringConfig = defineConfig(
      'clustering_params',
      'clustering_params_v2',
      CLUSTERING_PARAMS.values,
    );

    expect(() => replay(oneBatch, v2)).toThrow(/pins clustering_params=clustering_params_v1/);
    expect(
      replay(
        { ...oneBatch, configVersions: { ...PINNED, clustering_params: 'clustering_params_v2' } },
        v2,
      ).events,
    ).toHaveLength(1);
  });
});

describe('eviction is not deletion', () => {
  it('still reports an event whose cluster aged out of the working set', () => {
    const report = replay(reignition);

    expect(report.events).toHaveLength(2);
    expect(report.events.flatMap((event) => event.detectionUids).sort()).toEqual(
      [uid(1), uid(2)].sort(),
    );
  });

  it('offers the aged-out event as a reignition parent', () => {
    const report = replay(reignition);

    const child = theOnly(report.events, (event) => event.relation !== null);
    expect(child.detectionUids).toEqual([uid(2)]);
    expect(child.relation).toEqual({
      publicId: theOnly(report.events, (event) => event.detectionUids.includes(uid(1))).publicId,
      kind: 'possible_reignition',
    });
  });

  it('does not relate two detections that are still one cluster', () => {
    const report = replay({
      clockStart: '2026-08-04T03:00:00Z',
      batches: [
        {
          name: 'poll-01.json',
          availableAt: '2026-08-04T03:20:00Z',
          detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
        },
        {
          name: 'poll-02.json',
          availableAt: '2026-08-04T15:20:00Z',
          detections: [{ n: 2, acq: '2026-08-04T12:12:00Z', lon: '26.10500' }],
        },
      ],
    });

    const event = theOnly(report.events, () => true);
    expect(event.detectionUids).toEqual([uid(1), uid(2)]);
    expect(event.relation).toBeNull();
  });
});

describe('a merge loser is a tombstone', () => {
  it('reports the survivor holding every detection and the loser holding none', () => {
    const report = replay(merge);

    expect(report.events).toHaveLength(2);
    const tombstone = theOnly(report.events, (event) => event.mergedInto !== null);
    expect(tombstone.detectionUids).toEqual([]);

    const survivor = theOnly(report.events, (event) => event.publicId === tombstone.mergedInto);
    expect(survivor.mergedInto).toBeNull();
    expect(survivor.detectionUids).toEqual([uid(1), uid(2), uid(3)]);
  });

  it('leaves the two ids distinct, so the absorbed permalink still resolves', () => {
    const report = replay(merge);
    const publicIds = report.events.map((event) => event.publicId);

    expect(new Set(publicIds).size).toBe(publicIds.length);
  });

  it('keeps the seeds apart until something bridges them', () => {
    const firstBatch = merge.batches[0];
    if (firstBatch === undefined) throw new Error('unreachable: the fixture has two batches');
    const report = replay({ ...merge, batches: [firstBatch] });

    expect(report.events).toHaveLength(2);
    expect(report.events.every((event) => event.mergedInto === null)).toBe(true);
  });
});

describe('outcomes no implemented decision assigns', () => {
  it('reports labels as unanswered rather than as a guess, and the bucket as what it scored', () => {
    const report = replay({
      clockStart: '2026-08-05T03:00:00Z',
      batches: [
        {
          name: 'poll-01.json',
          availableAt: '2026-08-05T03:10:00Z',
          detections: [
            { n: 1, acq: '2026-08-05T00:06:00Z', lon: '26.10000' },
            { n: 2, acq: '2026-08-05T00:06:00Z', lon: '26.13000' },
          ],
        },
      ],
    });

    expect(report.events).not.toHaveLength(0);
    for (const event of report.events) {
      // The label rules (S3/S4) still have no implementation. `status` and `displayTier`
      // left this list when the lifecycle tick landed, and `bucket` left it with D12.
      expect(event.labels).toEqual([]);
      // Two VIIRS/S-NPP nominal night pixels at 12.5 MW inside one overpass, so review 11
      // §3.5 reads z = −2.0 + 1.8(0.80) + 0.7 + 0.5(ln 13.5 / ln 101) = 0.421966 and
      // score = 0.603954: over the 0.45 floor, under the 0.75 one.
      expect(event.bucket).toBe('likely');
    }
  });
});

describe('the lifecycle tick', () => {
  const oneDetection: FixtureSpec = {
    clockStart: '2026-08-04T03:00:00Z',
    batches: [
      {
        name: 'poll-01.json',
        availableAt: '2026-08-04T03:20:00Z',
        detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
      },
    ],
  };

  it('gives an event a real status and display tier rather than null', () => {
    const report = replay(oneDetection);

    const event = theOnly(report.events, () => true);
    // The fixture declares no weather, and a pass whose hour carries no cloud sample is
    // recorded `cloud_blocked` at zero weight — so no evidence accrues and the event stays
    // where the identity engine minted it, on the map.
    expect(event.status).toBe('active');
    expect(event.displayTier).toBe('map');
  });

  it('leaves a tombstone without a lifecycle of its own', () => {
    const report = replay(merge);

    const tombstone = theOnly(report.events, (event) => event.mergedInto !== null);
    expect(tombstone.status).toBeNull();
    expect(tombstone.displayTier).toBeNull();
  });

  it('keeps ticking an event whose cluster aged out of the working set', () => {
    const report = replay(reignition);

    // Both the archived parent and the event seeded five days later. An archived cluster
    // that stopped being ticked would report whatever tier it last held — or none at all.
    expect(report.events).toHaveLength(2);
    for (const event of report.events) {
      expect(event.status).toBe('active');
      expect(event.displayTier).toBe('map');
    }
  });

  it('carries the accumulated evidence across polls instead of restarting each one', () => {
    // Clear sky over the whole replay, so passes actually weigh. Two polls a day apart,
    // with only the first carrying a detection: the second window's evidence has to sit on
    // top of the first's, and an engine that rebuilt the carry would report a smaller E.
    const clear: ObservationContext = {
      cloudCover: hourlyClearSky('2026-08-04T00:00:00Z', 24 * 4),
      outages: [],
      declarations: [],
      zones: [],
      scores: [],
    };

    const spans = replay(
      {
        clockStart: '2026-08-04T03:00:00Z',
        batches: [
          {
            name: 'poll-01.json',
            availableAt: '2026-08-04T03:20:00Z',
            detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
          },
          {
            name: 'poll-02.json',
            availableAt: '2026-08-06T03:20:00Z',
            detections: [],
          },
        ],
      },
      undefined,
      clear,
    );
    const restarts = replay(
      {
        clockStart: '2026-08-04T03:00:00Z',
        batches: [
          {
            name: 'poll-01.json',
            availableAt: '2026-08-04T03:20:00Z',
            detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
          },
          { name: 'poll-02.json', availableAt: '2026-08-05T03:20:00Z', detections: [] },
          { name: 'poll-03.json', availableAt: '2026-08-06T03:20:00Z', detections: [] },
        ],
      },
      undefined,
      clear,
    );

    // Split into two windows or run as one, the evidence over the same 48 h reaches the
    // same conclusion. It only can if the second tick started from the first's total.
    expect(theOnly(restarts.events, () => true).status).toBe(
      theOnly(spans.events, () => true).status,
    );
    expect(theOnly(restarts.events, () => true).displayTier).toBe(
      theOnly(spans.events, () => true).displayTier,
    );
  });

  it('applies a curated declaration to the event holding the detection it names', () => {
    // The statement is dated into the gap between the two polls, so the tick that reads it
    // is one where nothing was detected. A statement dated alongside the detection would
    // prove less than it looks: a re-detection returns an event to `active` (A2.2), so the
    // assertion would pass or fail on gate 1 rather than on the declaration reaching the
    // right event.
    const report = replay(
      {
        clockStart: '2026-08-04T03:00:00Z',
        batches: [
          {
            name: 'poll-01.json',
            availableAt: '2026-08-04T03:20:00Z',
            detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
          },
          { name: 'poll-02.json', availableAt: '2026-08-04T09:20:00Z', detections: [] },
        ],
      },
      undefined,
      {
        cloudCover: [],
        outages: [],
        zones: [],
        scores: [],
        declarations: [
          {
            detectionUid: uid(1),
            state: 'officially_extinguished',
            declaredAtMs: Date.parse('2026-08-04T06:00:00Z'),
            attribution: 'РДПБЗН Пловдив',
          },
        ],
      },
    );

    const event = theOnly(report.events, () => true);
    // Only an attributed statement may put an event into an `officially_*` state (A2.2),
    // and the tick refuses to reach one on its own — so this can only have come from the
    // observations file, through the detection that names the event.
    expect(event.status).toBe('officially_extinguished');
    // Still on the map: a declaration ends the fire, not the reason to show where it was.
    expect(event.displayTier).toBe('map');
  });
});

describe('a re-delivered detection', () => {
  it('is evidence of one event once, not of two', () => {
    // The same row in two polls: the second country's download, or a provider replaying
    // its own file. S1 asserts this end to end; here it is isolated from the geometry.
    const report = replay({
      clockStart: '2026-08-04T03:00:00Z',
      batches: [
        {
          name: 'poll-01.json',
          availableAt: '2026-08-04T03:20:00Z',
          detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
        },
        {
          name: 'poll-02.json',
          availableAt: '2026-08-04T03:50:00Z',
          detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
        },
      ],
    });

    const event = theOnly(report.events, () => true);
    expect(event.detectionUids).toEqual([uid(1)]);
    expect(report.batches).toEqual([
      { name: 'poll-01.json', detections: 1 },
      { name: 'poll-02.json', detections: 1 },
    ]);
  });
});
