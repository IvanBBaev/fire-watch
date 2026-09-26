import { describe, expect, it } from 'vitest';

import { produceDigest, type DigestCandidate } from '../alerts/digest.js';
import type { AlertableEvent } from '../alerts/alert-decision.js';
import { epochMsFromIso } from '../ports/clock.js';
import type { AlertStateRow } from './alert-state.js';
import {
  buildZoneSeedPlan,
  type SeedingZone,
  type ZoneSeedCandidate,
  type ZoneSeedPlanInput,
} from './zone-seed-plan.js';

/**
 * The instants, computed by hand from the pinned configs and not from the code:
 *
 *   - Europe/Sofia is EEST (UTC+3) on 20 Aug 2026, so `05:20Z` is **08:20 local** — the
 *     moment the zone is drawn, outside `alert_gating_v1`'s 22:00–07:00 quiet window.
 *   - `digest_params_v1` opens the window at **09:00 local**, which on that date is
 *     `06:00Z`. That is the first window to open *after* the seed, and it is the exact
 *     subkey fixture S13 asserts.
 *   - `07:20Z` is 10:20 local: the first tick after the window opened, still outside quiet
 *     hours.
 *   - The window before the seed is 09:00 local on 19 Aug = `2026-08-19T06:00:00Z`, which
 *     is earlier than the account started watching — so a tick at `05:30Z` is owed nothing.
 */
const SEEDED_AT = epochMsFromIso('2026-08-20T05:20:00Z');
const BEFORE_WINDOW = epochMsFromIso('2026-08-20T05:30:00Z');
const WINDOW_START_ISO = '2026-08-20T06:00:00Z';
const AFTER_WINDOW = epochMsFromIso('2026-08-20T07:20:00Z');

const HOUR = 3_600_000;

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
    // Burning since well before the zone was drawn. That is the whole premise of A1.8.
    startedAt: SEEDED_AT - 48 * HOUR,
    lastDetectionAt: SEEDED_AT - HOUR,
    ...overrides,
  };
}

function zone(overrides: Partial<SeedingZone> = {}): SeedingZone {
  return {
    zoneId: 'zone-a',
    minScore: 0.45,
    timezone: 'Europe/Sofia',
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    newFireOverridesQuietHours: true,
    ...overrides,
  };
}

function candidate(overrides: Partial<ZoneSeedCandidate> = {}): ZoneSeedCandidate {
  return { event: event(), distanceKm: 3, ...overrides };
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

function input(overrides: Partial<ZoneSeedPlanInput> = {}): ZoneSeedPlanInput {
  return {
    zone: zone(),
    candidates: [candidate()],
    states: [],
    at: SEEDED_AT,
    ...overrides,
  };
}

describe('A1.8 — a zone drawn over a burning fire is seeded, not alerted', () => {
  it('writes notified_new with seeded_at and nothing else', () => {
    const plan = buildZoneSeedPlan(input());
    expect(plan.upserts).toEqual([
      {
        zoneId: 'zone-a',
        eventPublicId: 'fw-2026-a1b2c',
        state: 'notified_new',
        escalationWatermark: 0,
        seededAtIso: '2026-08-20T05:20:00Z',
        // Never notified: the user has not been told anything, and the suppression window
        // must not start from a message that was never sent.
        lastNotifiedAtIso: null,
      },
    ]);
    expect(plan.seededAtIso).toBe('2026-08-20T05:20:00Z');
  });

  it('cannot carry a send, because the plan has nowhere to put one', () => {
    // Structural, not behavioural: the "zero pushes" clause holds because no field of the
    // plan can reach a gateway, so no future edit can leak one through this path. The one
    // decision list (for the H7 log) carries no subkey, priority or next state.
    const plan = buildZoneSeedPlan(input());
    expect(Object.keys(plan).sort()).toEqual([
      'decisions',
      'onboarding',
      'seededAtIso',
      'skipped',
      'upserts',
      'zoneId',
    ]);
    for (const decision of plan.decisions) {
      expect(Object.keys(decision).sort()).toEqual([
        'alertType',
        'eventPublicId',
        'inQuietHours',
        'ladderStep',
        'outcome',
        'reason',
        'ruleVersion',
        'zoneId',
      ]);
    }
  });

  it('records one decision per candidate, seeded or skipped, in public-id order', () => {
    const plan = buildZoneSeedPlan(
      input({
        candidates: [
          candidate({ event: event({ publicId: 'fw-2026-zzzzz', geoOnly: true }) }),
          candidate(),
        ],
      }),
    );
    expect(plan.decisions.map((d) => [d.eventPublicId, d.outcome, d.reason])).toEqual([
      ['fw-2026-a1b2c', 'seed', 'pre_existing_event'],
      ['fw-2026-zzzzz', 'suppress', 'geo_only'],
    ]);
    for (const decision of plan.decisions) {
      expect(decision.zoneId).toBe('zone-a');
      expect(decision.alertType).toBeNull();
      expect(decision.ladderStep).toBe(0);
      expect(decision.ruleVersion).toBe('alert_gating_v1');
    }
  });

  it('surfaces each seeded fire for the onboarding list with its own distance', () => {
    const plan = buildZoneSeedPlan(
      input({
        candidates: [
          candidate({ distanceKm: 3.2 }),
          candidate({ event: event({ publicId: 'fw-2026-d3e4f' }), distanceKm: 9.8 }),
        ],
      }),
    );
    expect(plan.onboarding).toEqual([
      { zoneId: 'zone-a', eventPublicId: 'fw-2026-a1b2c', distanceKm: 3.2 },
      { zoneId: 'zone-a', eventPublicId: 'fw-2026-d3e4f', distanceKm: 9.8 },
    ]);
  });

  it('seeds nothing and still names the instant for a zone drawn over an empty map', () => {
    const plan = buildZoneSeedPlan(input({ candidates: [] }));
    expect(plan.upserts).toEqual([]);
    expect(plan.onboarding).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.seededAtIso).toBe('2026-08-20T05:20:00Z');
  });

  it('orders the plan by public id whatever order the query returned', () => {
    const plan = buildZoneSeedPlan(
      input({
        candidates: [
          candidate({ event: event({ publicId: 'fw-2026-g5h6j' }) }),
          candidate({ event: event({ publicId: 'fw-2026-a1b2c' }) }),
          candidate({ event: event({ publicId: 'fw-2026-d3e4f' }) }),
        ],
      }),
    );
    expect(plan.upserts.map((row) => row.eventPublicId)).toEqual([
      'fw-2026-a1b2c',
      'fw-2026-d3e4f',
      'fw-2026-g5h6j',
    ]);
  });
});

describe('the gates that decide what "currently alertable" means', () => {
  it('refuses a geostationary-only event at any score', () => {
    const plan = buildZoneSeedPlan(
      input({ candidates: [candidate({ event: event({ geoOnly: true, score: 0.99 }) })] }),
    );
    expect(plan.upserts).toEqual([]);
    expect(plan.skipped).toEqual([{ eventPublicId: 'fw-2026-a1b2c', reason: 'geo_only' }]);
  });

  it('refuses a single low-confidence detection — CI-3 holds at zone creation too', () => {
    const plan = buildZoneSeedPlan(
      input({
        candidates: [candidate({ event: event({ detectionCount: 1, score: 0.99 }) })],
        zone: zone({ minScore: 0.3 }),
      }),
    );
    expect(plan.skipped).toEqual([
      { eventPublicId: 'fw-2026-a1b2c', reason: 'insufficient_persistence' },
    ]);
  });

  it('seeds under the zones own sensitivity, not the system floor', () => {
    // alert_gating_v1: confirmed = 0.75. A zone created at the recommended position seeds
    // the 0.80 fire and leaves the 0.60 one out — the same knob that governs alerting.
    const plan = buildZoneSeedPlan(
      input({
        zone: zone({ minScore: 0.75 }),
        candidates: [
          candidate({ event: event({ publicId: 'fw-2026-a1b2c', score: 0.8 }) }),
          candidate({ event: event({ publicId: 'fw-2026-d3e4f', score: 0.6 }) }),
        ],
      }),
    );
    expect(plan.upserts.map((row) => row.eventPublicId)).toEqual(['fw-2026-a1b2c']);
    expect(plan.skipped).toEqual([
      { eventPublicId: 'fw-2026-d3e4f', reason: 'below_zone_threshold' },
    ]);
  });

  it('refuses an invalidated event and a quarantined batch', () => {
    const plan = buildZoneSeedPlan(
      input({
        candidates: [
          candidate({ event: event({ publicId: 'fw-2026-a1b2c', invalidated: true }) }),
          candidate({ event: event({ publicId: 'fw-2026-d3e4f', quarantined: true }) }),
        ],
      }),
    );
    expect(plan.upserts).toEqual([]);
    expect(plan.skipped).toEqual([
      { eventPublicId: 'fw-2026-a1b2c', reason: 'invalidated' },
      { eventPublicId: 'fw-2026-d3e4f', reason: 'quarantined_batch' },
    ]);
  });
});

describe('enlarging a zone', () => {
  it('leaves an existing seed alone rather than re-stamping it', () => {
    // The edit case. Re-seeding would move `seeded_at` forward and hand the fire a second
    // digest debt, which is how a zone edited every morning summarises the same fire daily.
    const existing = state({ seededAtIso: '2026-08-19T04:00:00.000Z' });
    const plan = buildZoneSeedPlan(input({ states: [existing] }));
    expect(plan.upserts).toEqual([]);
    expect(plan.onboarding).toEqual([]);
    expect(plan.skipped).toEqual([
      { eventPublicId: 'fw-2026-a1b2c', reason: 'pre_existing_event' },
    ]);
  });

  it('does not resurrect a pair the zone has already been alerted about', () => {
    const plan = buildZoneSeedPlan(
      input({
        states: [
          state({
            state: 'notified_escalation',
            escalationWatermark: 2,
            lastNotifiedAtIso: '2026-08-20T04:00:00.000Z',
          }),
        ],
      }),
    );
    expect(plan.upserts).toEqual([]);
    expect(plan.skipped).toEqual([
      { eventPublicId: 'fw-2026-a1b2c', reason: 'pre_existing_event' },
    ]);
  });

  it('does not seed over a cooldown', () => {
    const plan = buildZoneSeedPlan(input({ states: [state({ state: 'cooldown' })] }));
    expect(plan.upserts).toEqual([]);
    expect(plan.skipped).toEqual([{ eventPublicId: 'fw-2026-a1b2c', reason: 'cooldown' }]);
  });

  it('seeds only the newly covered events', () => {
    const plan = buildZoneSeedPlan(
      input({
        candidates: [
          candidate({ event: event({ publicId: 'fw-2026-a1b2c' }) }),
          candidate({ event: event({ publicId: 'fw-2026-d3e4f' }) }),
        ],
        states: [state({ eventPublicId: 'fw-2026-a1b2c' })],
      }),
    );
    expect(plan.upserts.map((row) => row.eventPublicId)).toEqual(['fw-2026-d3e4f']);
  });
});

describe('inputs the planner refuses', () => {
  it('refuses two candidates for one event', () => {
    expect(() => buildZoneSeedPlan(input({ candidates: [candidate(), candidate()] }))).toThrow(
      RangeError,
    );
  });

  it('refuses a state row belonging to another zone', () => {
    // Silently ignoring it would mean seeding a pair that already has a row — the exact
    // double-notification A1.8 removes.
    expect(() => buildZoneSeedPlan(input({ states: [state({ zoneId: 'zone-b' })] }))).toThrow(
      /zone-b/,
    );
  });

  it('refuses two unfolded state rows for one pair', () => {
    expect(() =>
      buildZoneSeedPlan(input({ states: [state(), state({ state: 'notified_escalation' })] })),
    ).toThrow(/fold/);
  });
});

describe('the seeded fire comes back in the next 09:00 digest, and not before it', () => {
  const plan = buildZoneSeedPlan(
    input({
      candidates: [
        candidate({ event: event({ publicId: 'fw-2026-a1b2c' }), distanceKm: 3.2 }),
        candidate({ event: event({ publicId: 'fw-2026-d3e4f' }), distanceKm: 9.8 }),
      ],
    }),
  );

  const candidates: readonly DigestCandidate[] = plan.onboarding.map((seeded) => ({
    zoneId: seeded.zoneId,
    eventPublicId: seeded.eventPublicId,
    distanceKm: seeded.distanceKm,
    kind: 'seeded',
    since: epochMsFromIso(plan.seededAtIso),
  }));

  const digestZones = [{ ...zone(), distanceKm: 3.2 }];

  it('says nothing at 08:30 local, forty minutes after the zone was drawn', () => {
    const decision = produceDigest({
      accountId: 'acct-01',
      zones: digestZones,
      candidates,
      lastWindowStartIso: null,
      watchingSince: SEEDED_AT,
      at: BEFORE_WINDOW,
    });
    expect(decision).toMatchObject({ outcome: 'none', reason: 'no_window_due', entries: [] });
  });

  it('reports both seeded fires in the 09:00 window, keyed by it', () => {
    const decision = produceDigest({
      accountId: 'acct-01',
      zones: digestZones,
      candidates,
      lastWindowStartIso: null,
      watchingSince: SEEDED_AT,
      at: AFTER_WINDOW,
    });
    expect(decision.outcome).toBe('send');
    expect(decision.reason).toBe('daily_summary');
    expect(decision.alertSubkey).toBe(WINDOW_START_ISO);
    expect(decision.entries.map((entry) => entry.eventPublicId)).toEqual([
      'fw-2026-a1b2c',
      'fw-2026-d3e4f',
    ]);
    expect(decision.entries.every((entry) => entry.kind === 'seeded')).toBe(true);
  });
});
