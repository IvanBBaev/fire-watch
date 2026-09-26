/**
 * H7 — the explanation held against `decideAlert`, not against a second copy of itself.
 *
 * Three claims, each one the thing a "why?" surface would get wrong silently:
 *
 *   - **Every branch has exactly one code.** A table of inputs reaches all sixteen
 *     `(outcome, reason)` pairs `decideAlert` and `chooseNotifyingZone` can produce, and
 *     a property run over arbitrary inputs checks that no decision escapes the table. A
 *     reason added to the decision without a row here fails both, which is the point:
 *     "why no alert?" would otherwise have nothing to say about it.
 *   - **The facts are the gate's, and coarse where the product is.** The sensitivity
 *     answer carries the bucket and the zone's named tier, never the raw score (D4); the
 *     rate-limit answer names which window held and until when.
 *   - **What survives in the rows reproduces what was decided.** A `send`'s headline is
 *     rebuilt byte-for-byte from the outbox row `outboxRowFor` writes; a `seed`'s from the
 *     state row, except the rule version that table has no column for; and a `defer` or
 *     a `suppress` from the decision log (migration 014) alone — without it, from nothing.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SCORE_BUCKET_FLOOR } from '@fire-watch/contracts';

import { ALERT_GATING } from '../config/alert-gating.js';
import { defineConfig } from '../config/versioned-config.js';
import type { OutboxRowDraft } from '../ports/alert-outbox-store.js';
import { epochMsFromIso, isoFromEpochMs } from '../ports/clock.js';
import type { AlertStateRow } from '../registry/alert-state.js';
import {
  DECISION_OUTCOMES,
  DECISION_REASONS,
  NOTHING_NOTIFIED,
  chooseNotifyingZone,
  decideAlert,
  type AlertDecision,
  type AlertDecisionInput,
  type AlertableEvent,
  type AlertZone,
} from './alert-decision.js';
import {
  EXPLANATION_BRANCHES,
  EXPLANATION_CODES,
  branchOf,
  explainDecision,
  explainPersisted,
  type ExplanationCode,
} from './explain.js';
import { decisionLogEntryFor } from './decision-log.js';
import { outboxRowFor, type OutboxBinding } from './outbox.js';

/** 15:00 in Sofia — outside quiet hours. */
const NOON = epochMsFromIso('2026-08-14T12:00:00Z');
/** 02:00 in Sofia — inside them. */
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

/** An escalation that rung 1 (Likely → Confirmed) would open, absent any other gate. */
const LADDER = {
  state: state(),
  lastNotified: { scoreBucket: 'likely', burnedAreaHa: null },
} as const satisfies Partial<AlertDecisionInput>;

const iso = isoFromEpochMs;

interface Scenario {
  readonly code: ExplanationCode;
  readonly input: AlertDecisionInput;
}

/**
 * One input per code. `suppressed_nearer_zone` is the exception: it is `chooseNotifyingZone`'s
 * branch, not `decideAlert`'s, so its input is decided and then demoted in {@link decide}.
 */
const SCENARIOS: readonly Scenario[] = [
  { code: 'sent_first_alert', input: input() },
  { code: 'sent_ladder_step', input: input(LADDER) },
  {
    code: 'deferred_digest_floor',
    input: input({ ...LADDER, state: state({ lastNotifiedAtIso: iso(NOON - 10 * MINUTE) }) }),
  },
  {
    code: 'deferred_suppression_window',
    input: input({ ...LADDER, state: state({ lastNotifiedAtIso: iso(NOON - 2 * HOUR) }) }),
  },
  {
    code: 'deferred_stale_trigger',
    input: input({ event: event({ lastDetectionAt: NOON - 2 * HOUR }) }),
  },
  {
    code: 'deferred_quiet_hours',
    input: input({
      at: NIGHT,
      event: event({ lastDetectionAt: NIGHT - 5 * MINUTE }),
      zone: zone({ newFireOverridesQuietHours: false }),
    }),
  },
  { code: 'seeded_pre_existing_event', input: input({ zoneCreation: true }) },
  { code: 'suppressed_quarantined_batch', input: input({ event: event({ quarantined: true }) }) },
  { code: 'suppressed_invalidated', input: input({ event: event({ invalidated: true }) }) },
  { code: 'suppressed_geo_only', input: input({ event: event({ geoOnly: true }) }) },
  {
    code: 'suppressed_insufficient_persistence',
    input: input({ event: event({ detectionCount: 1 }) }),
  },
  { code: 'suppressed_below_zone_threshold', input: input({ event: event({ score: 0.3 }) }) },
  { code: 'suppressed_cooldown', input: input({ state: state({ state: 'cooldown' }) }) },
  {
    code: 'suppressed_pre_existing_event',
    input: input({ zoneCreation: true, state: state() }),
  },
  {
    code: 'suppressed_no_new_ladder_step',
    input: input({
      state: state(),
      lastNotified: { scoreBucket: 'confirmed', burnedAreaHa: null },
    }),
  },
  { code: 'suppressed_nearer_zone', input: input({ zone: zone({ distanceKm: 40 }) }) },
];

/** The decision as the pipeline would hold it — including the A1.12 demotion. */
function decide(scenario: Scenario): AlertDecision {
  const decision = decideAlert(scenario.input);
  if (scenario.code !== 'suppressed_nearer_zone') return decision;
  const nearer = zone({ zoneId: 'zone-b', distanceKm: 1 });
  const [demoted] = chooseNotifyingZone([
    { zone: scenario.input.zone, decision },
    { zone: nearer, decision: decideAlert({ ...scenario.input, zone: nearer }) },
  ]);
  if (demoted === undefined) throw new Error('chooseNotifyingZone dropped an entry');
  return demoted.decision;
}

describe('the branch table', () => {
  it('has one code per branch, and every code is a branch', () => {
    const codes = EXPLANATION_BRANCHES.map((branch) => branch.code);
    const pairs = EXPLANATION_BRANCHES.map((branch) => `${branch.outcome}/${branch.reason}`);

    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect([...codes].sort()).toEqual([...EXPLANATION_CODES].sort());
  });

  it('names every reason and outcome decideAlert has', () => {
    // A new reason with no row here is a decision "why no alert?" cannot answer.
    const reasons = new Set(EXPLANATION_BRANCHES.map((branch) => branch.reason));
    const outcomes = new Set(EXPLANATION_BRANCHES.map((branch) => branch.outcome));

    expect([...reasons].sort()).toEqual([...DECISION_REASONS].sort());
    expect([...outcomes].sort()).toEqual([...DECISION_OUTCOMES].sort());
  });

  it('refuses a pair no decision takes, rather than guessing a code for it', () => {
    expect(() => branchOf('send', 'cooldown')).toThrow(RangeError);
    expect(() => branchOf('defer', 'first_alert')).toThrow(RangeError);
  });

  it('uses codes a catalog can key on, and no prose', () => {
    for (const code of EXPLANATION_CODES) expect(code).toMatch(/^[a-z]+(?:_[a-z]+)+$/);
  });
});

describe('every decision branch maps to exactly one explanation', () => {
  it('reaches all sixteen branches, one scenario each', () => {
    expect(SCENARIOS.map((scenario) => scenario.code).sort()).toEqual(
      [...EXPLANATION_CODES].sort(),
    );
  });

  it.each(SCENARIOS)('$code', (scenario) => {
    const decision = decide(scenario);
    const explanation = explainDecision(decision, scenario.input);

    expect(explanation.headline.code).toBe(scenario.code);
    expect(explanation.headline.outcome).toBe(decision.outcome);
    expect(explanation.headline.reason).toBe(decision.reason);
    // The facts belong to the gate the headline names, and to no other.
    expect(explanation.facts.gate).toBe(explanation.headline.gate);
    expect(explanation.headline.kind).toBe(
      decision.outcome === 'send' ? 'why_this_alert' : 'why_no_alert',
    );
  });

  it('never meets a decision it cannot explain, over arbitrary inputs', () => {
    const arbitraryInput = fc
      .record({
        score: fc.double({ min: 0, max: 1, noNaN: true }),
        detectionCount: fc.nat(4),
        nightHighConfidenceCount: fc.nat(2),
        geoOnly: fc.boolean(),
        invalidated: fc.boolean(),
        quarantined: fc.boolean(),
        detectionAgoMin: fc.nat(180),
        minScore: fc.constantFrom(0.3, 0.45, 0.75),
        override: fc.boolean(),
        stateKind: fc.constantFrom('none', 'notified_new', 'notified_escalation', 'cooldown'),
        watermark: fc.nat(3),
        notifiedAgoMin: fc.option(fc.nat(600)),
        zoneNotifiedAgoMin: fc.option(fc.nat(600)),
        lastBucket: fc.constantFrom(null, 'unverified', 'likely', 'confirmed'),
        zoneCreation: fc.boolean(),
        night: fc.boolean(),
      } as const)
      .map((v): AlertDecisionInput => {
        const at = v.night ? NIGHT : NOON;
        return input({
          at,
          event: event({
            score: v.score,
            detectionCount: v.detectionCount,
            nightHighConfidenceCount: v.nightHighConfidenceCount,
            geoOnly: v.geoOnly,
            invalidated: v.invalidated,
            quarantined: v.quarantined,
            lastDetectionAt: at - v.detectionAgoMin * MINUTE,
          }),
          zone: zone({ minScore: v.minScore, newFireOverridesQuietHours: v.override }),
          state:
            v.stateKind === 'none'
              ? null
              : state({
                  state: v.stateKind,
                  escalationWatermark: v.watermark,
                  lastNotifiedAtIso:
                    v.notifiedAgoMin === null ? null : iso(at - v.notifiedAgoMin * MINUTE),
                }),
          lastNotified: { scoreBucket: v.lastBucket, burnedAreaHa: null },
          zoneLastNotifiedAt:
            v.zoneNotifiedAgoMin === null ? null : at - v.zoneNotifiedAgoMin * MINUTE,
          zoneCreation: v.zoneCreation,
        });
      });

    fc.assert(
      fc.property(arbitraryInput, (given) => {
        const decision = decideAlert(given);
        const explanation = explainDecision(decision, given);
        const matching = EXPLANATION_BRANCHES.filter(
          (branch) => branch.outcome === decision.outcome && branch.reason === decision.reason,
        );

        expect(matching).toHaveLength(1);
        expect(explanation.headline.code).toBe(matching[0]?.code);
        expect(explanation.facts.gate).toBe(explanation.headline.gate);
      }),
      { numRuns: 500 },
    );
  });
});

describe('the facts are the answering gate’s', () => {
  const explain = (code: ExplanationCode, overrides: Partial<AlertDecisionInput> = {}) => {
    const scenario = SCENARIOS.find((candidate) => candidate.code === code);
    if (scenario === undefined) throw new Error(`no scenario for ${code}`);
    const given = { ...scenario.input, ...overrides };
    return explainDecision(decide({ code, input: given }), given);
  };

  it('answers a sensitivity miss with the bucket and the tier, never the raw score', () => {
    const { facts } = explain('suppressed_below_zone_threshold', {
      event: event({ score: 0.3172 }),
    });

    expect(facts).toEqual({
      gate: 'sensitivity',
      scoreBucket: 'unverified',
      zoneSensitivity: 'likely',
    });
    expect(JSON.stringify(facts)).not.toContain('0.3172');
  });

  it('treats the named tiers as the contracts’ bucket floors', () => {
    // The tier names are only honest while the gating floors are the buckets' floors.
    expect(ALERT_GATING.values.sensitivityFloors.confirmed).toBe(SCORE_BUCKET_FLOOR.confirmed);
    expect(ALERT_GATING.values.sensitivityFloors.likely).toBe(SCORE_BUCKET_FLOOR.likely);
  });

  it('quotes the persistence minima it compared against', () => {
    expect(explain('suppressed_insufficient_persistence').facts).toEqual({
      gate: 'system_gate',
      check: 'persistence',
      detectionCount: 1,
      minDetections: ALERT_GATING.values.minDetections,
      nightHighConfidenceCount: 0,
      minNightHighConfidenceDetections: ALERT_GATING.values.minNightHighConfidenceDetections,
    });
  });

  it('says which window held a deferral, the limit that answered, and when it closes', () => {
    const last = NOON - 10 * MINUTE;
    const floor = explain('deferred_digest_floor', {
      state: state({ lastNotifiedAtIso: iso(last) }),
    });

    expect(floor.headline.delivery).toBe('digest');
    expect(floor.facts).toEqual({
      gate: 'rate_limit',
      scope: 'this_event',
      lastNotifiedAtIso: iso(last),
      thresholdMs: ALERT_GATING.values.digestFloorMs,
      windowEndsAtIso: iso(last + ALERT_GATING.values.suppressionWindowMs),
    });
  });

  it('attributes the cross-event half of the window to the zone', () => {
    const zoneLast = NOON - HOUR;
    const { headline, facts } = explain('deferred_suppression_window', {
      state: state({ lastNotifiedAtIso: iso(NOON - 7 * HOUR) }),
      zoneLastNotifiedAt: zoneLast,
    });

    expect(headline.code).toBe('deferred_suppression_window');
    expect(facts).toMatchObject({ gate: 'rate_limit', scope: 'zone' });
    expect(facts).toMatchObject({ lastNotifiedAtIso: iso(zoneLast) });
  });

  it('dates a stale trigger from its last detection and the push TTL', () => {
    const last = NOON - 2 * HOUR;
    expect(explain('deferred_stale_trigger').facts).toEqual({
      gate: 'push_ttl',
      lastDetectionAtIso: iso(last),
      pushTtlMs: ALERT_GATING.values.pushTtlMs,
      expiredAtIso: iso(last + ALERT_GATING.values.pushTtlMs),
    });
  });

  it('names the first condition that kept a night-time message from piercing quiet hours', () => {
    const holdOf = (overrides: Partial<AlertDecisionInput>) => {
      const { facts } = explain('deferred_quiet_hours', overrides);
      return facts.gate === 'quiet_hours' ? facts.heldBecause : null;
    };

    expect(holdOf({})).toBe('override_off');
    expect(holdOf({ zone: zone({ minScore: 0.3 }) })).toBe('early_signals_zone');
    expect(holdOf({ ...LADDER, zone: zone() })).toBe('not_new_fire');
  });

  it('says a send that went out at night pierced quiet hours', () => {
    const given = input({ at: NIGHT, event: event({ lastDetectionAt: NIGHT - 5 * MINUTE }) });
    const { headline, facts } = explainDecision(decideAlert(given), given);

    expect(headline.code).toBe('sent_first_alert');
    expect(facts).toMatchObject({ gate: 'opened', piercedQuietHours: true, rung: null });
  });

  it('names the rung a ladder step announced, and the watermark a held one did not beat', () => {
    expect(explain('sent_ladder_step').facts).toMatchObject({ rung: 'score_upgrade' });
    expect(explain('suppressed_no_new_ladder_step').facts).toEqual({
      gate: 'escalation_ladder',
      step: 0,
      watermark: 0,
    });
  });
});

describe('explainDecision refuses a mismatched pair', () => {
  it('rather than explaining a decision against another zone’s input', () => {
    const decision = decideAlert(input());

    expect(() => explainDecision(decision, input({ zone: zone({ zoneId: 'zone-z' }) }))).toThrow(
      RangeError,
    );
  });

  it('rather than explaining it under a config it was not decided by', () => {
    const decision = decideAlert(input());
    const other = defineConfig('alert_gating', 'alert_gating_v999', ALERT_GATING.values);

    expect(() => explainDecision(decision, input(), other)).toThrow(RangeError);
  });

  it('and is deterministic for the pair it accepts', () => {
    for (const scenario of SCENARIOS) {
      const decision = decide(scenario);
      expect(explainDecision(decision, scenario.input)).toEqual(
        explainDecision(decision, scenario.input),
      );
    }
  });
});

const BINDING: OutboxBinding = {
  fireEventId: '42',
  triggerRefSeq: '7',
  channel: 'push',
  channelSubscriptionId: null,
  templateId: 'tpl',
  decidedAt: NOON,
};

function rowFor(decision: AlertDecision, at: number): OutboxRowDraft {
  const row = outboxRowFor(decision, { ...BINDING, decidedAt: at });
  if (row === null) throw new Error(`${decision.outcome}/${decision.reason} wrote no row`);
  return row;
}

describe('explainPersisted — what the rows can reproduce', () => {
  it.each(['sent_first_alert', 'sent_ladder_step'] as const)(
    'rebuilds a %s headline exactly from its outbox row',
    (code) => {
      const scenario = SCENARIOS.find((candidate) => candidate.code === code);
      if (scenario === undefined) throw new Error(`no scenario for ${code}`);
      const decision = decide(scenario);
      const live = explainDecision(decision, scenario.input);

      const persisted = explainPersisted({
        outbox: rowFor(decision, scenario.input.at),
        state: decision.nextState,
      });

      expect(persisted).toEqual(live.headline);
    },
  );

  it('rebuilds a higher rung from its step-N subkey', () => {
    const given = input({
      state: state({ escalationWatermark: 1 }),
      lastNotified: { scoreBucket: 'confirmed', burnedAreaHa: 10 },
      event: event({ burnedAreaHa: 40 }),
    });
    const decision = decideAlert(given);

    expect(decision.ladderStep).toBe(2);
    expect(explainPersisted({ outbox: rowFor(decision, NOON), state: null })).toEqual(
      explainDecision(decision, given).headline,
    );
  });

  it('rebuilds a seed from its state row, all but the rule version it has no column for', () => {
    const scenario = SCENARIOS.find((candidate) => candidate.code === 'seeded_pre_existing_event');
    if (scenario === undefined) throw new Error('no seed scenario');
    const decision = decide(scenario);

    const persisted = explainPersisted({ outbox: null, state: decision.nextState });

    expect(persisted).toEqual({
      ...explainDecision(decision, scenario.input).headline,
      ruleVersion: null,
    });
  });

  it('cannot rebuild a defer or a suppress without the decision log', () => {
    // Neither writes a row that names its reason outside `alert_decision_log`.
    for (const scenario of SCENARIOS) {
      const decision = decide(scenario);
      if (decision.outcome !== 'defer' && decision.outcome !== 'suppress') continue;

      expect(outboxRowFor(decision, BINDING)).toBeNull();
      expect(explainPersisted({ outbox: null, state: decision.nextState })).toBeNull();
    }
  });

  it('rebuilds every defer and suppress headline exactly from its decision log entry', () => {
    let rebuilt = 0;
    for (const scenario of SCENARIOS) {
      const decision = decide(scenario);
      if (decision.outcome !== 'defer' && decision.outcome !== 'suppress') continue;

      const persisted = explainPersisted({
        outbox: null,
        state: decision.nextState,
        log: [logged(decision, scenario.input.at)],
      });

      expect(persisted).toEqual(explainDecision(decision, scenario.input).headline);
      rebuilt += 1;
    }
    expect(rebuilt).toBe(13);
  });

  it('leaves digest and manual rows to their own explanations', () => {
    const row = rowFor(decideAlert(input()), NOON);

    expect(
      explainPersisted({
        outbox: { ...row, alertType: 'digest', triggerType: 'digest' },
        state: null,
      }),
    ).toBeNull();
    expect(explainPersisted({ outbox: { ...row, triggerType: 'manual' }, state: null })).toBeNull();
  });

  it('refuses a row whose subkey does not match its type', () => {
    const row = rowFor(decideAlert(input()), NOON);

    expect(() =>
      explainPersisted({ outbox: { ...row, alertSubkey: 'step-1' }, state: null }),
    ).toThrow(RangeError);
    expect(() =>
      explainPersisted({
        outbox: { ...row, alertType: 'escalation', triggerType: 'escalation', alertSubkey: 'once' },
        state: null,
      }),
    ).toThrow(RangeError);
  });
});

function logged(decision: AlertDecision, at: number, seq = '7') {
  return decisionLogEntryFor(decision, {
    fireEventId: BINDING.fireEventId,
    triggerRefSeq: seq,
    pass: 'evaluation',
    decidedAt: at,
  });
}

function scenarioFor(code: ExplanationCode): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate.code === code);
  if (scenario === undefined) throw new Error(`no scenario for ${code}`);
  return scenario;
}

describe('explainPersisted — over the decision log (migration 014)', () => {
  it('lets the outbox row answer a send, whatever the log holds', () => {
    const send = decide(scenarioFor('sent_first_alert'));
    const later = decide(scenarioFor('suppressed_cooldown'));

    const persisted = explainPersisted({
      outbox: rowFor(send, NOON),
      state: null,
      log: [logged(later, NOON + HOUR, '8')],
    });

    expect(persisted?.code).toBe('sent_first_alert');
  });

  it('answers with the latest entry, by decision instant and then trigger seq', () => {
    const deferred = decide(scenarioFor('deferred_stale_trigger'));
    const suppressed = decide(scenarioFor('suppressed_below_zone_threshold'));

    const byInstant = explainPersisted({
      outbox: null,
      state: null,
      log: [logged(suppressed, NOON + HOUR, '8'), logged(deferred, NOON, '9')],
    });
    const bySeq = explainPersisted({
      outbox: null,
      state: null,
      log: [logged(suppressed, NOON, '10'), logged(deferred, NOON, '9')],
    });

    expect(byInstant?.code).toBe('suppressed_below_zone_threshold');
    expect(bySeq?.code).toBe('suppressed_below_zone_threshold');
  });

  it('prefers the seed when the log entry predates it, and the log when it does not', () => {
    const seed = decide(scenarioFor('seeded_pre_existing_event'));
    const seedState = seed.nextState;
    if (seedState?.seededAtIso == null) throw new Error('the seed scenario left no seed');
    const seededAt = epochMsFromIso(seedState.seededAtIso);
    const suppressed = decide(scenarioFor('suppressed_below_zone_threshold'));

    const before = explainPersisted({
      outbox: null,
      state: seedState,
      log: [logged(suppressed, seededAt - MINUTE)],
    });
    const after = explainPersisted({
      outbox: null,
      state: seedState,
      log: [logged(suppressed, seededAt + MINUTE)],
    });

    expect(before?.code).toBe('seeded_pre_existing_event');
    expect(after?.code).toBe('suppressed_below_zone_threshold');
    expect(after?.ruleVersion).toBe(suppressed.ruleVersion);
  });

  it('refuses a log that mixes pairs', () => {
    const entry = logged(decide(scenarioFor('suppressed_cooldown')), NOON);

    expect(() =>
      explainPersisted({
        outbox: null,
        state: null,
        log: [entry, { ...entry, fireEventId: '43' }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      explainPersisted({ outbox: null, state: null, log: [entry, { ...entry, zoneId: 'zone-b' }] }),
    ).toThrow(RangeError);
  });

  it('refuses an entry whose code is not its branch', () => {
    const entry = logged(decide(scenarioFor('suppressed_cooldown')), NOON);

    expect(() =>
      explainPersisted({
        outbox: null,
        state: null,
        log: [{ ...entry, code: 'suppressed_geo_only' }],
      }),
    ).toThrow(RangeError);
  });

  it("refuses a log read beside another zone's rows", () => {
    const send = decide(scenarioFor('sent_first_alert'));
    const entry = logged(decide(scenarioFor('suppressed_cooldown')), NOON);
    const foreign = { ...entry, zoneId: 'zone-b' };

    expect(() =>
      explainPersisted({ outbox: rowFor(send, NOON), state: null, log: [foreign] }),
    ).toThrow(RangeError);
    expect(() =>
      explainPersisted({ outbox: null, state: state({ zoneId: 'zone-a' }), log: [foreign] }),
    ).toThrow(RangeError);
  });
});
