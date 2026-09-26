/**
 * The alert engine under replay (D9; gates CI-3, CI-5, CI-6).
 *
 * S13 asserts what a whole scenario decides, from disk, through the loader. These tests
 * assert the wiring S13 cannot isolate: the four decisions the engine's own header states,
 * and the three failure modes that would each leave a fixture green while it asserted
 * nothing — a gate run with no zones, a gate run against unpinned thresholds, and a merge
 * that manufactured a second "new fire" about a fire the zone was already told of.
 *
 * The geometry is the one `identity-engine.test.ts` derives and pins. At latitude 41.86 the
 * pinned scale gives 83.040264 km per degree of longitude, so 0.005 deg is 0.415 km, 0.015
 * deg is 1.246 km — just inside the 1.25 km VIIRS epsilon — and 0.03 deg is 2.491 km,
 * comfortably outside it. Nothing below re-derives those numbers: a retune that invalidates
 * them fails loudly in the sibling suite first.
 *
 * Two conventions keep the scenarios short enough to read. Every fire is seeded by a single
 * night-time high-confidence detection, because one of those *is* the other leg of the
 * system gate (A1.7) and it keeps a fire to one line. And every poll instant is daytime
 * UTC: quiet hours are the real 22:00–07:00 Europe/Sofia default, which is 19:00–04:00 UTC
 * in August, so no `defer` below is an accident of the hour someone happened to pick.
 */

import { describe, expect, it } from 'vitest';

import { ALERT_GATING, type AlertGatingParams } from '../config/alert-gating.js';
import type { DigestParams } from '../config/digest-params.js';
import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';
import { epochMsFromIso } from '../ports/clock.js';
import { alertEngine } from './alert-engine.js';
import {
  parseFixtureManifest,
  parseReplayBatch,
  type FixtureScore,
  type FixtureZone,
  type ObservationContext,
} from './fixture-format.js';
import { runReplay, type ReplayAlert, type ReplayFixture, type ReplayReport } from './runner.js';

/** A syntactically valid detection uid. The digest is only verified by the loader. */
const uid = (n: number): string => String(n).padStart(64, '0');

/** The five the inner engine checks, plus the one this engine adds. */
const PINNED = Object.freeze({
  clustering_params: 'clustering_params_v1',
  lifecycle_params: 'lifecycle_params_v1',
  pass_table: 'pass_table_v0',
  score_params: 'score_params_v0',
  sources: 'source_registry_v1',
  alert_gating: 'alert_gating_v1',
  digest_params: 'digest_params_v1',
});

interface DetectionSpec {
  readonly n: number;
  readonly acq: string;
  readonly lon: string;
  /** Both default to the system gate's night-time leg; a test that wants it shut says so. */
  readonly confidence?: string;
  readonly dayNight?: string;
  readonly source?: string;
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
  readonly zones: readonly FixtureZone[];
  readonly scores: readonly FixtureScore[];
}

interface ZoneSpec {
  readonly zoneId: string;
  readonly accountId?: string;
  readonly createdAt?: string;
  readonly minScore?: number;
  readonly distanceKm?: number;
}

/**
 * A watch zone as `observations.json` states one. Built rather than parsed: the parser has
 * its own suite, and a test that went through it would fail for two different reasons.
 */
function zone(spec: ZoneSpec): FixtureZone {
  return {
    zoneId: spec.zoneId,
    accountId: spec.accountId ?? 'acct-01',
    createdAtMs: epochMsFromIso(spec.createdAt ?? '2026-08-20T07:00:00Z'),
    minScore: spec.minScore ?? 0.45,
    timezone: 'Europe/Sofia',
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    // Off, so that a `send` below is a send on the ordinary path rather than one that
    // pierced quiet hours — the tests that care about the hour would not say so otherwise.
    newFireOverridesQuietHours: false,
    distanceKm: spec.distanceKm ?? 5,
  };
}

/** An effective-from score entry, naming its event by a detection that event holds. */
function score(n: number, from: string, value: number): FixtureScore {
  return { detectionUid: uid(n), fromMs: epochMsFromIso(from), score: value };
}

function makeFixture(spec: FixtureSpec): ReplayFixture {
  const observations: ObservationContext = {
    // No sky, no outages and no statements: every scenario here is about who was told,
    // and a fixture that declared weather would move the lifecycle underneath the gate.
    cloudCover: [],
    outages: [],
    declarations: [],
    zones: spec.zones,
    scores: spec.scores,
  };

  const manifest = parseFixtureManifest(
    {
      id: 'T-alert',
      title: 'alert engine unit fixture',
      asserts: 'whatever the test around it asserts',
      required: 'suite',
      owner: 'WP6',
      engine: 'alert',
      clockStart: spec.clockStart,
      mode: 'live',
      allowRevive: false,
      configVersions: { ...(spec.configVersions ?? PINNED) },
      inputs: spec.batches.map((batch) => batch.name),
      expected: 'expected.json',
    },
    'T-alert/manifest.json',
  );

  return {
    manifest,
    batches: spec.batches.map((batch) =>
      parseReplayBatch(
        {
          availableAt: batch.availableAt,
          detections: batch.detections.map((detection) => ({
            detectionUid: uid(detection.n),
            source: detection.source ?? 'firms:viirs:snpp',
            acqTsIso: detection.acq,
            latCanonical: '41.86000',
            lonCanonical: detection.lon,
            confidence: detection.confidence ?? 'high',
            frpMw: 41.5,
            dayNight: detection.dayNight ?? 'N',
          })),
        },
        batch.name,
      ),
    ),
    expected: null,
    observations,
  };
}

function replay(
  spec: FixtureSpec,
  gating?: VersionedConfig<AlertGatingParams>,
  digest?: VersionedConfig<DigestParams>,
): ReplayReport {
  return runReplay(
    makeFixture(spec),
    alertEngine({
      ...(gating === undefined ? {} : { gating }),
      ...(digest === undefined ? {} : { digest }),
    }),
  );
}

/** Every decision recorded at one poll instant, in the order the engine emitted them. */
function decisionsAt(report: ReplayReport, atIso: string): readonly ReplayAlert[] {
  return report.alerts.filter((alert) => alert.atIso === atIso);
}

/**
 * The push decisions at one poll instant — the four the gate makes about *this* detection,
 * without the daily summary the second pass adds about everything still burning.
 *
 * A poll that happens to be the first one past 09:00 local emits both, and they are two
 * different statements about the same fire: "this changed" and "this is still true". Tests
 * about the gate say so by asking for the pushes; the digest has its own suite, and S13 and
 * S14 assert it end to end.
 */
function pushesAt(report: ReplayReport, atIso: string): readonly ReplayAlert[] {
  return decisionsAt(report, atIso).filter((alert) => alert.alertType !== 'digest');
}

/** The one item matching `predicate`, or a failure naming how many there really were. */
function theOnly<T>(items: readonly T[], predicate: (item: T) => boolean): T {
  const matches = items.filter(predicate);
  expect(matches).toHaveLength(1);
  const first = matches[0];
  if (first === undefined) throw new Error('unreachable: length was asserted above');
  return first;
}

/** One fire, one zone, one poll — the smallest thing that reaches the gate at all. */
const oneFire: FixtureSpec = {
  clockStart: '2026-08-20T08:00:00Z',
  zones: [zone({ zoneId: 'zone-a' })],
  scores: [score(1, '2026-08-20T08:00:00Z', 0.82)],
  batches: [
    {
      name: 'poll-01.json',
      availableAt: '2026-08-20T09:00:00Z',
      detections: [{ n: 1, acq: '2026-08-20T08:40:00Z', lon: '26.10000' }],
    },
  ],
};

describe('a gate with nothing to run on', () => {
  it('refuses a fixture that watches nothing, because "no alerts" would otherwise be recorded as the scenario answer', () => {
    // The quiet failure this whole suite cannot absorb: zero zones means zero decisions,
    // and `alerts: []` in an expected.json is indistinguishable from a gate that never ran.
    expect(() => replay({ ...oneFire, zones: [] })).toThrow(
      /alert engine was given no zones .* would record that as "no alerts" \(ADR-004 A1\.7\)/s,
    );
  });

  it('refuses a fixture that scores nothing, because every event would then sit below every gate by default', () => {
    // Scores are stated, never computed (ADR-002 D6 has no implementation). An unscored
    // fixture is not "a scenario where nothing qualified"; it is a scenario with no input.
    expect(() => replay({ ...oneFire, scores: [] })).toThrow(
      /alert engine was given no scores .* leaves every event below every gate by default/s,
    );
  });
});

describe('the alert_gating pin', () => {
  it('refuses a fixture that names no gating version, because a replay against unnamed thresholds asserts nothing about them', () => {
    const { alert_gating: _omitted, ...withoutGating } = PINNED;

    expect(() => replay({ ...oneFire, configVersions: withoutGating })).toThrow(
      /does not pin "alert_gating"/,
    );
  });

  it('refuses a fixture authored against a different gating version, so a refit cannot silently re-decide last August', () => {
    expect(() =>
      replay({ ...oneFire, configVersions: { ...PINNED, alert_gating: 'alert_gating_v2' } }),
    ).toThrow(/pins alert_gating=alert_gating_v2 but the replay runs alert_gating_v1/);
  });

  it('gates under the parameter set it was handed rather than a module default, which is what makes a v2 fixture possible', () => {
    // Same values, different version: the only thing that changes is which fixtures the
    // engine will accept — exactly what the `gating` option exists for.
    const v2: VersionedConfig<AlertGatingParams> = defineConfig(
      'alert_gating',
      'alert_gating_v2',
      ALERT_GATING.values,
    );

    expect(() => replay(oneFire, v2)).toThrow(/pins alert_gating=alert_gating_v1/);
    expect(
      replay({ ...oneFire, configVersions: { ...PINNED, alert_gating: 'alert_gating_v2' } }, v2)
        .alerts,
    ).not.toHaveLength(0);
  });
});

describe('a score is effective-from', () => {
  /**
   * One fire, three polls, and two entries for it declared newest-first so that the
   * engine's own sort is what puts them in order. The zone sits at 0.75 and the scores
   * straddle it, so which entry was in force is readable straight off the outcome.
   */
  const rising: FixtureSpec = {
    clockStart: '2026-08-20T08:00:00Z',
    zones: [zone({ zoneId: 'zone-a', minScore: 0.75 })],
    scores: [score(1, '2026-08-20T13:00:00Z', 0.9), score(1, '2026-08-20T10:00:00Z', 0.5)],
    batches: [
      {
        name: 'poll-01.json',
        availableAt: '2026-08-20T09:00:00Z',
        detections: [{ n: 1, acq: '2026-08-20T08:40:00Z', lon: '26.10000' }],
      },
      { name: 'poll-02.json', availableAt: '2026-08-20T11:00:00Z', detections: [] },
      {
        // 0.415 km away, so the same fire — and recent enough that the A1.5 push TTL is
        // not what answers at 13:00.
        name: 'poll-03.json',
        availableAt: '2026-08-20T13:00:00Z',
        detections: [{ n: 2, acq: '2026-08-20T12:50:00Z', lon: '26.10500' }],
      },
    ],
  };

  it('decides nothing at all for an event no score names yet, because a default would assert the harness rather than the gate', () => {
    // Not "suppress, below threshold" — that would be a statement about a number nobody
    // stated. The event is simply not alertable, and the report says so by staying empty.
    expect(decisionsAt(replay(rising), '2026-08-20T09:00:00Z')).toEqual([]);
  });

  it('takes the last entry already in force, so a fixture raises a score by adding a row rather than by editing history', () => {
    const decision = theOnly(decisionsAt(replay(rising), '2026-08-20T11:00:00Z'), () => true);

    // 0.50 is in force and 0.90 is still in the future; a `scoreAt` that took the maximum,
    // or the last row in file order, would have sent here.
    expect(decision.outcome).toBe('suppress');
    expect(decision.reason).toBe('below_zone_threshold');
  });

  it('treats the effective instant as inclusive, so a poll landing exactly on it already carries the new number', () => {
    const decision = theOnly(decisionsAt(replay(rising), '2026-08-20T13:00:00Z'), () => true);

    // The poll is at 13:00:00Z and so is the entry. Half-open the other way and this would
    // still be `below_zone_threshold`, which is the same silence for the opposite reason.
    expect(decision.outcome).toBe('send');
    expect(decision.reason).toBe('first_alert');
    expect(decision.alertType).toBe('new_fire');
  });
});

describe('a merge moves the alert state before the gate sees it', () => {
  /**
   * Two seeds 0.03 deg apart — 2.491 km, so two events — and a third detection halfway
   * between them, 1.246 km from each and inside epsilon of both. Only the *younger* seed is
   * scored, so only it is ever notified about; the older one wins the survivor rule
   * (`min by started_at`), which is what makes this scenario prove something: the notified
   * state has to travel onto an id that never carried one.
   */
  const merge: FixtureSpec = {
    clockStart: '2026-08-20T08:00:00Z',
    zones: [zone({ zoneId: 'zone-a' })],
    scores: [score(2, '2026-08-20T07:00:00Z', 0.82)],
    batches: [
      {
        name: 'poll-01.json',
        availableAt: '2026-08-20T09:00:00Z',
        detections: [
          { n: 1, acq: '2026-08-20T08:40:00Z', lon: '26.10000' },
          { n: 2, acq: '2026-08-20T08:50:00Z', lon: '26.13000' },
        ],
      },
      {
        name: 'poll-02.json',
        availableAt: '2026-08-20T11:00:00Z',
        detections: [{ n: 3, acq: '2026-08-20T10:50:00Z', lon: '26.11500' }],
      },
    ],
  };

  it('folds the parent state onto the survivor, so a merge can never manufacture a second new_fire (I3, gate CI-5)', () => {
    const report = replay(merge);
    const tombstone = theOnly(report.events, (event) => event.mergedInto !== null);

    // The zone was told about the loser before the merge — that is the state that has to
    // survive the change of id.
    const seeded = theOnly(decisionsAt(report, '2026-08-20T09:00:00Z'), () => true);
    expect(seeded.publicId).toBe(tombstone.publicId);
    expect(seeded.outcome).toBe('seed');

    const afterMerge = theOnly(decisionsAt(report, '2026-08-20T11:00:00Z'), () => true);
    expect(afterMerge.publicId).toBe(tombstone.mergedInto);
    // An unfolded row would have read `none` here and announced a first alert about a fire
    // this zone has been holding since 09:00, under an id the API now redirects away from.
    expect(afterMerge.outcome).toBe('suppress');
    expect(afterMerge.reason).toBe('no_new_ladder_step');
    expect(report.alerts.some((alert) => alert.alertType === 'new_fire')).toBe(false);
  });

  it('stops gating the tombstone, because a pointer to the survivor is not a second fire to decide about', () => {
    const report = replay(merge);
    const tombstone = theOnly(report.events, (event) => event.mergedInto !== null);

    expect(
      decisionsAt(report, '2026-08-20T11:00:00Z').map((alert) => alert.publicId),
    ).not.toContain(tombstone.publicId);
  });
});

describe('the zone-creation boundary (A1.8)', () => {
  /**
   * One fire alive before the zones exist and one born in the very poll the first zone
   * starts evaluating. `zone-on-time` is drawn at 11:00:00Z exactly; `zone-a-ms-late` one
   * millisecond after, on its own account so the nearest-zone contest cannot be what
   * separates them.
   */
  const drawnMidReplay: FixtureSpec = {
    clockStart: '2026-08-20T08:00:00Z',
    zones: [
      zone({ zoneId: 'zone-on-time', createdAt: '2026-08-20T11:00:00Z' }),
      zone({
        zoneId: 'zone-a-ms-late',
        accountId: 'acct-02',
        createdAt: '2026-08-20T11:00:00.001Z',
      }),
    ],
    scores: [score(1, '2026-08-20T08:00:00Z', 0.82), score(3, '2026-08-20T10:00:00Z', 0.9)],
    batches: [
      {
        name: 'poll-01.json',
        availableAt: '2026-08-20T09:00:00Z',
        detections: [{ n: 1, acq: '2026-08-20T08:40:00Z', lon: '26.10000' }],
      },
      {
        // 0.4 deg east — 33 km — so this is a second fire, not the first one moving.
        name: 'poll-02.json',
        availableAt: '2026-08-20T11:00:00Z',
        detections: [{ n: 3, acq: '2026-08-20T10:50:00Z', lon: '26.50000' }],
      },
    ],
  };

  it('evaluates nothing for a zone that did not exist yet, so a fixture cannot alert a zone about the past', () => {
    expect(decisionsAt(replay(drawnMidReplay), '2026-08-20T09:00:00Z')).toEqual([]);
  });

  it('evaluates a zone drawn at exactly this instant, because the boundary is the moment the zone becomes real', () => {
    const report = replay(drawnMidReplay);
    const onTime = decisionsAt(report, '2026-08-20T11:00:00Z').filter(
      (alert) => alert.zoneId === 'zone-on-time',
    );

    // Seeded, not sent: both fires predate the zone as far as the zone is concerned, and
    // A1.8 says a fire that predates a zone is state rather than news.
    expect(onTime).toHaveLength(2);
    for (const alert of onTime) {
      expect(alert.outcome).toBe('seed');
      expect(alert.reason).toBe('pre_existing_event');
      expect(alert.alertType).toBeNull();
    }

    // One millisecond later is still later. The comparison is `at < createdAtMs`, and a
    // `<=` here would seed a zone against a snapshot taken before it was drawn.
    expect(decisionsAt(report, '2026-08-20T11:00:00Z').map((alert) => alert.zoneId)).not.toContain(
      'zone-a-ms-late',
    );
  });

  it('seeds a fire born in the seeding poll itself, because A1.8 is one evaluation over the whole snapshot', () => {
    const report = replay(drawnMidReplay);
    const born = theOnly(report.events, (event) => event.detectionUids.includes(uid(3)));

    // Marking the zone seeded inside the per-event loop instead of after it would make the
    // second event of the same poll "ordinary" and send a 3 a.m. alert about it.
    const decision = theOnly(
      decisionsAt(report, '2026-08-20T11:00:00Z'),
      (alert) => alert.zoneId === 'zone-on-time' && alert.publicId === born.publicId,
    );
    expect(decision.outcome).toBe('seed');
  });
});

describe('the nearest-zone contest is per account (A1.12)', () => {
  /**
   * Two zones of one account and one of another, all watching the same fire. The empty
   * first poll exists only to spend A1.8's one seeding evaluation, which is a per-zone
   * one-off and not what this scenario is about.
   */
  const contested: FixtureSpec = {
    clockStart: '2026-08-20T08:00:00Z',
    zones: [
      zone({ zoneId: 'zone-near', distanceKm: 3.2 }),
      zone({ zoneId: 'zone-far', distanceKm: 9.8 }),
      zone({ zoneId: 'zone-other', accountId: 'acct-02', distanceKm: 12 }),
    ],
    scores: [score(1, '2026-08-20T10:00:00Z', 0.82)],
    batches: [
      { name: 'poll-01.json', availableAt: '2026-08-20T09:00:00Z', detections: [] },
      {
        name: 'poll-02.json',
        availableAt: '2026-08-20T11:00:00Z',
        detections: [{ n: 1, acq: '2026-08-20T10:50:00Z', lon: '26.10000' }],
      },
      { name: 'poll-03.json', availableAt: '2026-08-20T13:00:00Z', detections: [] },
    ],
  };

  it('lets one account hear about a fire once, from the nearest of its zones', () => {
    const first = decisionsAt(replay(contested), '2026-08-20T11:00:00Z');
    const near = theOnly(first, (alert) => alert.zoneId === 'zone-near');
    const far = theOnly(first, (alert) => alert.zoneId === 'zone-far');

    expect(near.outcome).toBe('send');
    expect(near.reason).toBe('first_alert');
    expect(near.alertSubkey).toBe('once');
    // Demoted rather than dropped: "why no alert?" is a product surface, and `nearer_zone`
    // is the answer it renders.
    expect(far.outcome).toBe('suppress');
    expect(far.reason).toBe('nearer_zone');
  });

  it('does not let one account silence another, because "the nearest of my zones" says nothing about anyone else', () => {
    const first = decisionsAt(replay(contested), '2026-08-20T11:00:00Z');
    const other = theOnly(first, (alert) => alert.zoneId === 'zone-other');

    // 12 km away and last in zone order: contested against acct-01's zones it would have
    // lost every tie-break there is.
    expect(other.outcome).toBe('send');
    expect(other.reason).toBe('first_alert');
  });

  it('advances the loser state anyway, so the second-nearest zone cannot re-fire about the same fire later', () => {
    const later = decisionsAt(replay(contested), '2026-08-20T13:00:00Z');
    const far = theOnly(later, (alert) => alert.zoneId === 'zone-far');

    expect(far.outcome).toBe('suppress');
    // `no_new_ladder_step` and not `first_alert`: the demotion kept `nextState`, so this
    // zone is on the escalation path even though it has never sent anything.
    expect(far.reason).toBe('no_new_ladder_step');
  });

  it('reports the bucket it computed, not the stated score that just alerted, because a gate input is not an outcome', () => {
    const report = replay(contested);

    expect(report.alerts.some((alert) => alert.outcome === 'send')).toBe(true);
    for (const event of report.events) {
      // 0.82 drove the decision and must still never be readable back as a fixture answer.
      // Now that D12's scorer exists the separation is visible rather than merely stated:
      // one VIIRS/S-NPP high night pixel at 41.5 MW scores 0.693421, so the event reports
      // `likely` while the stated 0.82 that alerted would have read `confirmed`.
      expect(event.bucket).toBe('likely');
    }
  });
});

describe('what an empty outbox costs the harness', () => {
  it('cannot reach the score-upgrade rung, because lastNotified is what the user read and a replay has no outbox', () => {
    // Likely at 11:00, Confirmed at 13:00 — rung 1 exactly. It cannot hold: the rung
    // compares against the bucket the last *message* carried, and `NOTHING_NOTIFIED` has
    // none. This is the limit the engine header states, not a rule the gate is missing.
    const report = replay({
      clockStart: '2026-08-20T08:00:00Z',
      zones: [zone({ zoneId: 'zone-a' })],
      scores: [score(1, '2026-08-20T10:00:00Z', 0.5), score(1, '2026-08-20T13:00:00Z', 0.9)],
      batches: [
        { name: 'poll-01.json', availableAt: '2026-08-20T09:00:00Z', detections: [] },
        {
          name: 'poll-02.json',
          availableAt: '2026-08-20T11:00:00Z',
          detections: [{ n: 1, acq: '2026-08-20T10:50:00Z', lon: '26.10000' }],
        },
        {
          name: 'poll-03.json',
          availableAt: '2026-08-20T13:00:00Z',
          detections: [{ n: 2, acq: '2026-08-20T12:50:00Z', lon: '26.10500' }],
        },
      ],
    });

    expect(theOnly(decisionsAt(report, '2026-08-20T11:00:00Z'), () => true).outcome).toBe('send');

    const upgraded = theOnly(decisionsAt(report, '2026-08-20T13:00:00Z'), () => true);
    expect(upgraded.outcome).toBe('suppress');
    expect(upgraded.reason).toBe('no_new_ladder_step');
  });
});

describe('a reignition link is a parent chain too', () => {
  /**
   * The sibling suite's reignition geometry, moved into daylight. 5 days between the polls
   * is past the 72 h active window, so the first cluster is evicted and the second
   * detection seeds a new event; 120 h between the acquisitions is past T_LINK (48 h) and
   * inside the 14-day fallback window, and 0.415 km is inside 2 x epsilon.
   */
  const reignition: FixtureSpec = {
    clockStart: '2026-08-04T09:00:00Z',
    zones: [zone({ zoneId: 'zone-a', createdAt: '2026-08-04T08:00:00Z' })],
    scores: [score(1, '2026-08-04T08:00:00Z', 0.82), score(2, '2026-08-09T09:00:00Z', 0.82)],
    batches: [
      {
        name: 'poll-01.json',
        availableAt: '2026-08-04T10:00:00Z',
        detections: [{ n: 1, acq: '2026-08-04T09:40:00Z', lon: '26.10000' }],
      },
      {
        name: 'poll-02.json',
        availableAt: '2026-08-09T10:00:00Z',
        detections: [{ n: 2, acq: '2026-08-09T09:40:00Z', lon: '26.10500' }],
      },
    ],
  };

  it('escalates the child rather than announcing it, because A1.6 chooses the type on the chain and not on the event id', () => {
    const report = replay(reignition);
    const child = theOnly(report.events, (event) => event.relation !== null);

    const decision = theOnly(
      pushesAt(report, '2026-08-09T10:00:00Z'),
      (alert) => alert.publicId === child.publicId,
    );
    // Rung 3 is the one rung a replay can reach — it reads the event, not the message —
    // and reaching it at all proves the parent's row arrived on the child before the gate.
    expect(decision.outcome).toBe('send');
    expect(decision.reason).toBe('ladder_step');
    expect(decision.alertType).toBe('escalation');
    expect(decision.alertSubkey).toBe('step-3');
  });

  it('stops gating the reignition parent, because its state moved to the child and an id cannot hold two', () => {
    const report = replay(reignition);
    const child = theOnly(report.events, (event) => event.relation !== null);
    const parent = theOnly(report.events, (event) => event.publicId !== child.publicId);

    // `migrateParentStates` *moves* rows, and a reignition parent — unlike a merge
    // tombstone — stays in the snapshot as an archived event. Gate it anyway and the fire
    // the zone was seeded on five days ago returns with `state: none` and is decided as a
    // first alert under its old id; only the 30-minute push TTL turns that into a `defer`
    // rather than a send, and in an `offline` fixture the CI-6 guard would fail the run for
    // a decision the gate should never have been asked to make.
    expect(
      decisionsAt(report, '2026-08-09T10:00:00Z').filter(
        (alert) => alert.publicId === parent.publicId,
      ),
    ).toHaveLength(0);
    // The chain still speaks — through the child, exactly once.
    expect(
      pushesAt(report, '2026-08-09T10:00:00Z').filter((alert) => alert.publicId === child.publicId),
    ).toHaveLength(1);
  });
});
