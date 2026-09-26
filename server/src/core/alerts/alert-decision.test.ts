import { describe, expect, it } from 'vitest';

import { ALERT_GATING } from '../config/alert-gating.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import { foldAlertStates, type AlertStateRow } from '../registry/alert-state.js';
import {
  DECISION_OUTCOMES,
  NEW_FIRE_SUBKEY,
  NOTHING_NOTIFIED,
  chooseNotifyingZone,
  decideAlert,
  escalationStep,
  escalationSubkey,
  isInQuietHours,
  type AlertDecisionInput,
  type AlertableEvent,
  type AlertZone,
  type ZoneDecision,
} from './alert-decision.js';

/** 15:00 in Sofia — comfortably outside quiet hours, so a test says so when it means it. */
const NOON = epochMsFromIso('2026-08-14T12:00:00Z');
/** 02:00 in Sofia. */
const NIGHT = epochMsFromIso('2026-08-14T23:00:00Z');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function event(overrides: Partial<AlertableEvent> = {}): AlertableEvent {
  return {
    publicId: 'fw-2026-a1b2c',
    score: 0.8,
    detectionCount: 3,
    nightHighConfidenceCount: 0,
    geoOnly: false,
    invalidated: false,
    quarantined: false,
    status: 'active',
    statusBefore: null,
    relationKind: null,
    burnedAreaHa: null,
    startedAt: NOON - HOUR,
    lastDetectionAt: NOON - 5 * MINUTE,
    ...overrides,
  };
}

function zone(overrides: Partial<AlertZone> = {}): AlertZone {
  return {
    zoneId: 'zone-a',
    minScore: 0.45,
    timezone: 'Europe/Sofia',
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    newFireOverridesQuietHours: true,
    distanceKm: 3,
    ...overrides,
  };
}

function state(overrides: Partial<AlertStateRow> = {}): AlertStateRow {
  return {
    zoneId: 'zone-a',
    eventPublicId: 'fw-2026-a1b2c',
    state: 'notified_new',
    escalationWatermark: 0,
    seededAtIso: null,
    lastNotifiedAtIso: null,
    ...overrides,
  };
}

function input(overrides: Partial<AlertDecisionInput> = {}): AlertDecisionInput {
  return {
    event: event(),
    zone: zone(),
    state: null,
    lastNotified: NOTHING_NOTIFIED,
    zoneLastNotifiedAt: null,
    zoneCreation: false,
    at: NOON,
    ...overrides,
  };
}

describe('the system gate (ADR-004 D4, A1.7 — CI-3)', () => {
  it('never alerts from a single low-confidence detection', () => {
    // The invariant the whole file exists for. Score is irrelevant here: the persistence
    // condition is not user-adjustable, so no zone setting can reach this branch.
    const decision = decideAlert(
      input({ event: event({ detectionCount: 1, score: 0.99 }), zone: zone({ minScore: 0.3 }) }),
    );
    expect(decision.outcome).toBe('suppress');
    expect(decision.reason).toBe('insufficient_persistence');
    expect(decision.nextState).toBeNull();
  });

  it('accepts one night-time high-confidence detection in place of the count', () => {
    const decision = decideAlert(
      input({ event: event({ detectionCount: 1, nightHighConfidenceCount: 1 }) }),
    );
    expect(decision.outcome).toBe('send');
    expect(decision.alertType).toBe('new_fire');
  });

  it('never alerts on geostationary evidence alone, at any score', () => {
    const decision = decideAlert(
      input({ event: event({ geoOnly: true, score: 0.99, detectionCount: 40 }) }),
    );
    expect(decision).toMatchObject({ outcome: 'suppress', reason: 'geo_only' });
  });

  it('never alerts on an invalidated event', () => {
    const decision = decideAlert(input({ event: event({ invalidated: true }) }));
    expect(decision).toMatchObject({ outcome: 'suppress', reason: 'invalidated' });
  });

  it('makes no decision at all from a quarantined batch (A1.5)', () => {
    const decision = decideAlert(input({ event: event({ quarantined: true }) }));
    expect(decision).toMatchObject({ outcome: 'suppress', reason: 'quarantined_batch' });
    expect(decision.nextState).toBeNull();
  });
});

describe('zone sensitivity (A1.7)', () => {
  it('holds a Likely event back from a Confirmed-only zone', () => {
    const decision = decideAlert(
      input({ event: event({ score: 0.5 }), zone: zone({ minScore: 0.75 }) }),
    );
    expect(decision).toMatchObject({ outcome: 'suppress', reason: 'below_zone_threshold' });
  });

  it('alerts the same event to a Likely+ zone', () => {
    const decision = decideAlert(
      input({ event: event({ score: 0.5 }), zone: zone({ minScore: 0.45 }) }),
    );
    expect(decision.outcome).toBe('send');
  });

  it('alerts an Unverified event to a zone that opted in to early signals', () => {
    const decision = decideAlert(
      input({ event: event({ score: 0.35 }), zone: zone({ minScore: 0.3 }) }),
    );
    expect(decision.outcome).toBe('send');
  });

  it('refuses a zone floor below the 0.30 opt-in', () => {
    // Not a clamp. A zone stored below the floor means something wrote a value the
    // product never offers, and quietly treating it as 0.30 would hide that.
    expect(() => decideAlert(input({ zone: zone({ minScore: 0.2 }) }))).toThrow(RangeError);
  });
});

describe('choosing the alert type on the parent chain (A1.6)', () => {
  it('calls the first news of a fire a new_fire', () => {
    const decision = decideAlert(input());
    expect(decision).toMatchObject({
      outcome: 'send',
      reason: 'first_alert',
      alertType: 'new_fire',
      alertSubkey: NEW_FIRE_SUBKEY,
      ladderStep: 0,
    });
    expect(decision.nextState?.state).toBe('notified_new');
  });

  it('never says new_fire about a fire the zone already heard about through a parent', () => {
    // The merge child has a brand-new public id; the folded state is what remembers that
    // this zone was already told. Deciding on the id alone is exactly the bug A1.6 names.
    const folded = foldAlertStates(
      [
        state({ eventPublicId: 'fw-2026-parent', state: 'notified_new' }),
        state({ eventPublicId: 'fw-2026-parent2', state: 'none' }),
      ],
      'fw-2026-child',
      ['fw-2026-parent', 'fw-2026-parent2'],
    );
    const decision = decideAlert(
      input({
        event: event({ publicId: 'fw-2026-child', relationKind: 'possible_reignition' }),
        state: folded[0] ?? null,
      }),
    );
    expect(decision.alertType).toBe('escalation');
    expect(decision.outcome).toBe('send');
  });

  it('calls a re-detection after an official extinguishment an escalation (A2.2, S12)', () => {
    const decision = decideAlert(
      input({
        event: event({ status: 'active', statusBefore: 'officially_extinguished' }),
        state: state({ state: 'notified_new' }),
      }),
    );
    expect(decision).toMatchObject({ alertType: 'escalation', outcome: 'send', ladderStep: 3 });
  });
});

describe('the escalation ladder (A1.11)', () => {
  const params = ALERT_GATING.values;

  it('numbers the rungs in ladder order', () => {
    expect(escalationSubkey(1)).toBe('step-1');
    expect(() => escalationSubkey(0)).toThrow(RangeError);
  });

  it('holds rung 1 on a Likely → Confirmed upgrade only', () => {
    expect(
      escalationStep(event({ score: 0.8 }), { scoreBucket: 'likely', burnedAreaHa: null }),
    ).toBe(1);
    expect(
      escalationStep(event({ score: 0.8 }), { scoreBucket: 'confirmed', burnedAreaHa: null }),
    ).toBe(0);
  });

  it('holds rung 2 on a doubling above the 10 ha floor and not below it', () => {
    expect(
      escalationStep(event({ burnedAreaHa: 25 }), { scoreBucket: null, burnedAreaHa: 12 }),
    ).toBe(2);
    // 1 ha → 5 ha is a doubling in arithmetic and not in news; the floor is what says so.
    expect(escalationStep(event({ burnedAreaHa: 5 }), { scoreBucket: null, burnedAreaHa: 1 })).toBe(
      0,
    );
  });

  it('holds rung 3 on re-detection out of a weakened state', () => {
    expect(escalationStep(event({ statusBefore: 'no_longer_detected' }), NOTHING_NOTIFIED)).toBe(3);
    // `archived` is past T_LINK: that path mints a new event with a reignition link, and
    // routing it here as well would escalate the same fire twice.
    expect(escalationStep(event({ statusBefore: 'archived' }), NOTHING_NOTIFIED)).toBe(0);
  });

  it('takes the highest holding rung, not a count of them', () => {
    const all = event({ score: 0.8, burnedAreaHa: 40, statusBefore: 'signal_weakening' });
    expect(escalationStep(all, { scoreBucket: 'likely', burnedAreaHa: 15 }, params)).toBe(3);
  });

  it('fires only on a step strictly above the watermark', () => {
    const climbing = event({ score: 0.8 });
    const notified = { scoreBucket: 'likely', burnedAreaHa: null } as const;

    const first = decideAlert(
      input({ event: climbing, state: state({ escalationWatermark: 0 }), lastNotified: notified }),
    );
    expect(first).toMatchObject({ outcome: 'send', ladderStep: 1, alertSubkey: 'step-1' });
    expect(first.nextState?.escalationWatermark).toBe(1);

    // The same rung re-crossing forever — score oscillating across the bucket boundary —
    // must notify once and never again.
    const again = decideAlert(
      input({ event: climbing, state: state({ escalationWatermark: 1 }), lastNotified: notified }),
    );
    expect(again).toMatchObject({ outcome: 'suppress', reason: 'no_new_ladder_step' });
  });

  it('bounds an event at one escalation per rung, so three per zone for its whole life', () => {
    const decision = decideAlert(
      input({
        event: event({ statusBefore: 'signal_weakening' }),
        state: state({ escalationWatermark: 3 }),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'suppress', reason: 'no_new_ladder_step' });
  });
});

describe('there is no all-clear (ADR-004 D4)', () => {
  it('has no outcome that could carry one', () => {
    expect(DECISION_OUTCOMES).toEqual(['send', 'defer', 'seed', 'suppress']);
  });

  it('says nothing when a fire stops being detected', () => {
    const decision = decideAlert(
      input({
        event: event({ status: 'no_longer_detected', statusBefore: 'active' }),
        state: state({ state: 'notified_new' }),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'suppress', reason: 'no_new_ladder_step' });
  });

  it('says nothing when a score falls back to Likely', () => {
    const decision = decideAlert(
      input({
        event: event({ score: 0.5 }),
        state: state({ state: 'notified_escalation', escalationWatermark: 1 }),
        lastNotified: { scoreBucket: 'confirmed', burnedAreaHa: null },
      }),
    );
    expect(decision).toMatchObject({ outcome: 'suppress', reason: 'no_new_ladder_step' });
  });
});

describe('rate limits (ADR-004 D3)', () => {
  it('folds a second notification inside 30 minutes into the digest', () => {
    const decision = decideAlert(
      input({
        event: event({ statusBefore: 'signal_weakening' }),
        state: state({ lastNotifiedAtIso: '2026-08-14T11:50:00Z' }),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'defer', reason: 'digest_floor' });
    // Deferred is decided, not delivered — the state advances so the same rung cannot be
    // decided twice, but the window keeps running from the message the user actually got.
    expect(decision.nextState?.escalationWatermark).toBe(3);
    expect(decision.nextState?.lastNotifiedAtIso).toBe('2026-08-14T11:50:00Z');
  });

  it('defers inside the ~6 h window and sends after it', () => {
    const escalating = event({ statusBefore: 'signal_weakening' });
    const inside = decideAlert(
      input({ event: escalating, state: state({ lastNotifiedAtIso: '2026-08-14T10:00:00Z' }) }),
    );
    expect(inside).toMatchObject({ outcome: 'defer', reason: 'suppression_window' });

    const outside = decideAlert(
      input({ event: escalating, state: state({ lastNotifiedAtIso: '2026-08-14T05:00:00Z' }) }),
    );
    expect(outside).toMatchObject({ outcome: 'send', reason: 'ladder_step' });
    expect(outside.nextState?.lastNotifiedAtIso).toBe('2026-08-14T12:00:00Z');
  });

  it("never lets another fire's traffic suppress a zone's first alert about this one", () => {
    const decision = decideAlert(input({ zoneLastNotifiedAt: NOON - HOUR }));
    expect(decision).toMatchObject({ outcome: 'send', alertType: 'new_fire' });
  });

  it('does hold an escalation back behind other-event traffic', () => {
    const decision = decideAlert(
      input({
        event: event({ statusBefore: 'signal_weakening' }),
        state: state({ state: 'notified_new' }),
        zoneLastNotifiedAt: NOON - HOUR,
      }),
    );
    expect(decision).toMatchObject({ outcome: 'defer', reason: 'suppression_window' });
  });

  it('says nothing at all once the pair is in cooldown', () => {
    const decision = decideAlert(input({ state: state({ state: 'cooldown' }) }));
    expect(decision).toMatchObject({ outcome: 'suppress', reason: 'cooldown', nextState: null });
  });
});

describe('the push TTL (A1.5)', () => {
  it('folds a new_fire about an hours-old detection into the digest instead of pushing', () => {
    // The released-quarantine case: the batch replays through the ordinary path, and the
    // user must not receive a burst of "new fire" about fires that started this morning.
    const decision = decideAlert(
      input({ event: event({ lastDetectionAt: NOON - 2 * HOUR, startedAt: NOON - 3 * HOUR }) }),
    );
    expect(decision).toMatchObject({ outcome: 'defer', reason: 'stale_trigger' });
  });

  it('pushes a new_fire whose trigger is inside the TTL', () => {
    const decision = decideAlert(input({ event: event({ lastDetectionAt: NOON - 20 * MINUTE }) }));
    expect(decision.outcome).toBe('send');
  });
});

describe('quiet hours (A1.7 — fixture S14)', () => {
  it('classifies through the tz database, not from the UTC clock', () => {
    // 21:00 UTC is 00:00 in Sofia — quiet — and a naive reading would call it daytime.
    expect(isInQuietHours(epochMsFromIso('2026-08-14T21:00:00Z'), zone())).toBe(true);
    // 05:00 UTC is 08:00 in Sofia — awake — and a naive reading would call it night.
    expect(isInQuietHours(epochMsFromIso('2026-08-14T05:00:00Z'), zone())).toBe(false);
  });

  it('keeps both passes of the repeated hour quiet on DST fallback', () => {
    // 2026-10-25: 04:00 EEST becomes 03:00 EET. Both 03:30s are inside 22:00–07:00.
    expect(isInQuietHours(epochMsFromIso('2026-10-25T00:30:00Z'), zone())).toBe(true);
    expect(isInQuietHours(epochMsFromIso('2026-10-25T01:30:00Z'), zone())).toBe(true);
  });

  it('classifies the instant, not the wall clock, across the spring-forward gap', () => {
    // 2027-03-28: 03:00 EET becomes 04:00 EEST. The local hour 03:00–04:00 does not
    // exist; asking about the instant either side of it still answers.
    expect(isInQuietHours(epochMsFromIso('2027-03-28T00:59:00Z'), zone())).toBe(true);
    expect(isInQuietHours(epochMsFromIso('2027-03-28T01:00:00Z'), zone())).toBe(true);
    expect(isInQuietHours(epochMsFromIso('2027-03-28T04:30:00Z'), zone())).toBe(false);
  });

  it('lets a Likely+ new_fire pierce quiet hours by default', () => {
    const decision = decideAlert(
      input({ event: event({ lastDetectionAt: NIGHT - 5 * MINUTE }), at: NIGHT }),
    );
    expect(decision).toMatchObject({ outcome: 'send', alertType: 'new_fire', inQuietHours: true });
  });

  it('respects quiet hours for an escalation', () => {
    const decision = decideAlert(
      input({
        event: event({ statusBefore: 'signal_weakening', lastDetectionAt: NIGHT - 5 * MINUTE }),
        state: state({ state: 'notified_new' }),
        at: NIGHT,
      }),
    );
    expect(decision).toMatchObject({ outcome: 'defer', reason: 'quiet_hours' });
  });

  it('respects an account that turned the override off', () => {
    const decision = decideAlert(
      input({
        event: event({ lastDetectionAt: NIGHT - 5 * MINUTE }),
        zone: zone({ newFireOverridesQuietHours: false }),
        at: NIGHT,
      }),
    );
    expect(decision).toMatchObject({ outcome: 'defer', reason: 'quiet_hours' });
  });

  it('never wakes anyone for an early-signals alert', () => {
    // "May still be a real fire" at 3 a.m. is not worth the trust it spends — the
    // override belongs to new_fire at Likely+ only.
    const decision = decideAlert(
      input({
        event: event({ score: 0.35, lastDetectionAt: NIGHT - 5 * MINUTE }),
        zone: zone({ minScore: 0.3 }),
        at: NIGHT,
      }),
    );
    expect(decision).toMatchObject({ outcome: 'defer', reason: 'quiet_hours' });
  });

  it('rejects a zone whose timezone cannot be resolved', () => {
    expect(() => isInQuietHours(NOON, zone({ timezone: 'Europe/Atlantis' }))).toThrow(RangeError);
  });
});

describe('zone creation seeds without sending (A1.8 — stand-in for fixture S13)', () => {
  const created = NOON;

  it('seeds an already-burning fire at notified_new with no alert', () => {
    const decision = decideAlert(
      input({ event: event({ startedAt: created - 6 * HOUR }), zoneCreation: true, at: created }),
    );
    expect(decision).toMatchObject({
      outcome: 'seed',
      reason: 'pre_existing_event',
      alertType: null,
      alertSubkey: null,
      priority: null,
    });
    expect(decision.nextState).toMatchObject({
      state: 'notified_new',
      escalationWatermark: 0,
      seededAtIso: '2026-08-14T12:00:00Z',
      lastNotifiedAtIso: null,
    });
  });

  it('sends nothing for any pre-existing event and normally for later ones', () => {
    // S13 in miniature: three fires already burning when the zone is drawn, one that
    // starts afterwards. Zero sends from the seeding pass; the newcomer alerts.
    const preExisting = ['fw-2026-old1', 'fw-2026-old2', 'fw-2026-old3'].map((publicId) =>
      decideAlert(
        input({
          event: event({ publicId, startedAt: created - 4 * HOUR }),
          zoneCreation: true,
          at: created,
        }),
      ),
    );
    expect(preExisting.map((d) => d.outcome)).toEqual(['seed', 'seed', 'seed']);
    expect(preExisting.every((d) => d.alertType === null)).toBe(true);

    const later = decideAlert(
      input({
        event: event({
          publicId: 'fw-2026-new1',
          startedAt: created + HOUR,
          lastDetectionAt: created + HOUR + 5 * MINUTE,
        }),
        at: created + HOUR + 10 * MINUTE,
      }),
    );
    expect(later).toMatchObject({ outcome: 'send', alertType: 'new_fire' });
  });

  it('escalates a seeded event once it crosses a ladder step', () => {
    const seeded = decideAlert(
      input({ event: event({ startedAt: created - 6 * HOUR }), zoneCreation: true, at: created }),
    );
    const next = decideAlert(
      input({
        event: event({ score: 0.8, startedAt: created - 6 * HOUR }),
        state: seeded.nextState,
        lastNotified: { scoreBucket: 'likely', burnedAreaHa: null },
        at: created + 6 * HOUR,
      }),
    );
    expect(next).toMatchObject({ outcome: 'send', alertType: 'escalation', ladderStep: 1 });
    // Seeding left no `lastNotifiedAt`, so nothing in the suppression window holds this
    // back — the zone has never actually been sent anything about this fire.
    expect(seeded.nextState?.lastNotifiedAtIso).toBeNull();
  });

  it('re-seeds a pair that was already notified without alerting again', () => {
    // A zone deleted and re-created re-seeds from scratch; the state is already there
    // when the same person redraws the same circle, and it must stay silent.
    const decision = decideAlert(
      input({ state: state({ state: 'notified_escalation' }), zoneCreation: true }),
    );
    expect(decision).toMatchObject({ outcome: 'suppress', reason: 'pre_existing_event' });
  });
});

describe('one notification per event across a users zones (A1.12)', () => {
  function candidate(zoneId: string, distanceKm: number): ZoneDecision {
    const z = zone({ zoneId, distanceKm });
    return { zone: z, decision: decideAlert(input({ zone: z })) };
  }

  it('renders from the nearest zone and advances the rest', () => {
    const chosen = chooseNotifyingZone([
      candidate('zone-far', 12),
      candidate('zone-near', 2),
      candidate('zone-mid', 6),
    ]);
    const sending = chosen.filter((entry) => entry.decision.outcome === 'send');
    expect(sending.map((entry) => entry.zone.zoneId)).toEqual(['zone-near']);
    // A losing zone must not be able to re-fire later about the same fire.
    const loser = chosen.find((entry) => entry.zone.zoneId === 'zone-far');
    expect(loser?.decision.reason).toBe('nearer_zone');
    expect(loser?.decision.nextState?.state).toBe('notified_new');
  });

  it('breaks a tie on the lowest zone id, through the quantum', () => {
    // Two zones drawn round the same village differ by floating-point noise. Without the
    // quantum the pinned tie-break would be unreachable and the winner would be luck.
    const chosen = chooseNotifyingZone([
      candidate('zone-b', 4.000000000000001),
      candidate('zone-a', 4),
    ]);
    const sending = chosen.filter((entry) => entry.decision.outcome === 'send');
    expect(sending.map((entry) => entry.zone.zoneId)).toEqual(['zone-a']);
  });

  it('leaves a set with nothing to send untouched', () => {
    const nothing = [
      {
        zone: zone({ zoneId: 'zone-a' }),
        decision: decideAlert(input({ event: event({ geoOnly: true }) })),
      },
    ];
    expect(chooseNotifyingZone(nothing)).toEqual(nothing);
  });
});

describe('the decision is a function of its inputs (I5)', () => {
  it('returns the same value twice for the same input', () => {
    const twice: AlertDecisionInput = input({ at: NIGHT });
    expect(decideAlert(twice)).toEqual(decideAlert(twice));
  });

  it('stamps the gating config version on every decision', () => {
    const at: EpochMs = NOON;
    expect(decideAlert(input({ at })).ruleVersion).toBe('alert_gating_v1');
    expect(decideAlert(input({ event: event({ geoOnly: true }), at })).ruleVersion).toBe(
      'alert_gating_v1',
    );
  });

  it('assigns the A1.2 queue priority from the alert type alone', () => {
    expect(decideAlert(input()).priority).toBe(ALERT_GATING.values.priorities.new_fire);
    const escalation = decideAlert(
      input({ event: event({ statusBefore: 'signal_weakening' }), state: state() }),
    );
    expect(escalation.priority).toBe(ALERT_GATING.values.priorities.escalation);
  });
});
