import { describe, expect, it } from 'vitest';

import { ALERT_GATING } from '../config/alert-gating.js';
import { DIGEST_PARAMS } from '../config/digest-params.js';
import type { AlertZone } from './alert-decision.js';
import {
  produceDigest,
  windowStartAtOrBefore,
  type DigestCandidate,
  type DigestInput,
} from './digest.js';

const PARAMS = DIGEST_PARAMS.values;

function zone(overrides: Partial<AlertZone> = {}): AlertZone {
  return {
    zoneId: 'zone-a',
    minScore: 0.45,
    timezone: 'Europe/Sofia',
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    newFireOverridesQuietHours: true,
    distanceKm: 5,
    ...overrides,
  };
}

function candidate(overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    zoneId: 'zone-a',
    eventPublicId: 'fw-2026-aaaa',
    distanceKm: 5,
    kind: 'active',
    since: Date.parse('2026-08-19T12:00:00Z'),
    ...overrides,
  };
}

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    accountId: 'acct-01',
    zones: [zone()],
    candidates: [candidate()],
    lastWindowStartIso: null,
    // Long before every `at` below, so the "not watching yet" guard is never the reason a
    // scenario says nothing; the one test that is about it overrides this.
    watchingSince: Date.parse('2026-01-01T00:00:00Z'),
    at: Date.parse('2026-08-20T06:00:00Z'),
    ...overrides,
  };
}

const window = (iso: string): number =>
  windowStartAtOrBefore(Date.parse(iso), 'Europe/Sofia', PARAMS);

describe('locating the 09:00 window', () => {
  it('lands on 09:00 local, not 09:00 UTC', () => {
    // Sofia is UTC+3 in August. A digest resolved in UTC would arrive at noon.
    expect(new Date(window('2026-08-20T10:00:00Z')).toISOString()).toBe('2026-08-20T06:00:00.000Z');
  });

  it('reaches back to yesterday before the window opens', () => {
    expect(new Date(window('2026-08-20T05:59:59Z')).toISOString()).toBe('2026-08-19T06:00:00.000Z');
  });

  it('opens exactly at the window instant, not a millisecond later', () => {
    expect(window('2026-08-20T06:00:00Z')).toBe(Date.parse('2026-08-20T06:00:00Z'));
  });

  it('crosses the October fallback, where two windows are 25 hours apart', () => {
    // Europe/Sofia leaves DST at 01:00Z on 2026-10-25, so that local day is 25 hours long.
    const saturday = window('2026-10-24T06:30:00Z');
    const sunday = window('2026-10-25T07:30:00Z');
    expect(new Date(saturday).toISOString()).toBe('2026-10-24T06:00:00.000Z');
    expect(new Date(sunday).toISOString()).toBe('2026-10-25T07:00:00.000Z');
    expect(sunday - saturday).toBe(25 * 3_600_000);
  });

  it('crosses the March spring-forward, where two windows are 23 hours apart', () => {
    // And 01:00Z on 2027-03-28 makes that local day 23 hours long.
    const saturday = window('2027-03-27T07:30:00Z');
    const sunday = window('2027-03-28T06:30:00Z');
    expect(new Date(saturday).toISOString()).toBe('2027-03-27T07:00:00.000Z');
    expect(new Date(sunday).toISOString()).toBe('2027-03-28T06:00:00.000Z');
    expect(sunday - saturday).toBe(23 * 3_600_000);
  });

  it('refuses the shortcut of adding a day of milliseconds', () => {
    // The failure this whole mechanism exists to prevent: 24h after the 24 Oct window is
    // 08:00 local, not 09:00, and it is also *before* the 25th's real window — so a
    // watermark advanced arithmetically would send that Sunday two digests.
    const saturday = window('2026-10-24T06:30:00Z');
    const naive = saturday + 86_400_000;
    expect(naive).not.toBe(window('2026-10-25T07:30:00Z'));
    expect(naive).toBeLessThan(window('2026-10-25T07:30:00Z'));
  });

  it('reads a zone that is not ours, so the mechanism is the tz database and not a constant', () => {
    // Kathmandu is +05:45. Nothing in the product points there today; the point is that
    // nothing in the producer assumes whole hours either.
    const at = Date.parse('2026-08-20T04:00:00Z');
    const start = windowStartAtOrBefore(at, 'Asia/Kathmandu', PARAMS);
    expect(new Date(start).toISOString()).toBe('2026-08-20T03:15:00.000Z');
  });

  it('rejects a timezone the tz database does not know', () => {
    expect(() => windowStartAtOrBefore(Date.now(), 'Europe/Atlantis', PARAMS)).toThrow(RangeError);
  });
});

describe('what a due window produces', () => {
  it("sends the account's first digest, because a new reader's first window is a real one", () => {
    const decision = produceDigest(input());
    expect(decision.outcome).toBe('send');
    expect(decision.reason).toBe('daily_summary');
    expect(decision.windowStartIso).toBe('2026-08-20T06:00:00Z');
    expect(decision.advanceWatermark).toBe(true);
    expect(decision.entries).toEqual([
      { zoneId: 'zone-a', eventPublicId: 'fw-2026-aaaa', distanceKm: 5, kind: 'active' },
    ]);
  });

  it('keys every row of one window alike, which is what makes it one message', () => {
    const decision = produceDigest(
      input({
        candidates: [
          candidate({ eventPublicId: 'fw-2026-bbbb' }),
          candidate({ eventPublicId: 'fw-2026-cccc' }),
        ],
      }),
    );
    expect(decision.alertType).toBe('digest');
    expect(decision.alertSubkey).toBe(decision.windowStartIso);
    expect(decision.entries).toHaveLength(2);
  });

  it('carries the gating priority and the digest rule version', () => {
    const decision = produceDigest(input());
    expect(decision.priority).toBe(ALERT_GATING.values.priorities.digest);
    expect(decision.ruleVersion).toBe(DIGEST_PARAMS.version);
  });

  it('says nothing at all once the window has been given', () => {
    const first = produceDigest(input());
    const second = produceDigest(input({ lastWindowStartIso: first.windowStartIso }));
    expect(second.outcome).toBe('none');
    expect(second.reason).toBe('no_window_due');
    expect(second.entries).toEqual([]);
    expect(second.advanceWatermark).toBe(false);
  });

  it('comes back the next day under a new key', () => {
    const first = produceDigest(input());
    const next = produceDigest(
      input({ lastWindowStartIso: first.windowStartIso, at: Date.parse('2026-08-21T06:00:00Z') }),
    );
    expect(next.outcome).toBe('send');
    expect(next.alertSubkey).toBe('2026-08-21T06:00:00Z');
  });

  it('owes nothing for a window that opened before the reader drew the zone', () => {
    // Signing up at 11:00 Sofia: today's 09:00 window is two hours in the past, and a
    // "daily summary" delivered two hours late about a day nobody was watching is not one.
    const decision = produceDigest(
      input({
        watchingSince: Date.parse('2026-08-20T08:00:00Z'),
        at: Date.parse('2026-08-20T09:00:00Z'),
      }),
    );
    expect(decision.outcome).toBe('none');
    expect(decision.reason).toBe('no_window_due');
    expect(decision.advanceWatermark).toBe(false);
  });

  it('and pays that reader tomorrow, because the guard delays the first digest rather than skipping it', () => {
    const decision = produceDigest(
      input({
        watchingSince: Date.parse('2026-08-20T08:00:00Z'),
        at: Date.parse('2026-08-21T06:00:00Z'),
      }),
    );
    expect(decision.outcome).toBe('send');
    expect(decision.alertSubkey).toBe('2026-08-21T06:00:00Z');
  });
});

describe('quiet hours hold the window instead of spending it', () => {
  // A reader whose quiet hours swallow the window. A1.7 applies quiet hours to `digest`
  // and 07 §5.5.3 says the digest never overrides them, so the only honest answer is to
  // wait — which is only honest if the window survives the wait.
  const nightOwl = zone({ quietHoursStart: '07:00', quietHoursEnd: '12:00' });

  it('holds without advancing the watermark', () => {
    const decision = produceDigest(input({ zones: [nightOwl] }));
    expect(decision.outcome).toBe('hold');
    expect(decision.reason).toBe('quiet_hours');
    expect(decision.windowStartIso).toBe('2026-08-20T06:00:00Z');
    expect(decision.advanceWatermark).toBe(false);
    expect(decision.entries).toEqual([]);
  });

  it('delivers the same window, under the same key, once the quiet hours end', () => {
    const held = produceDigest(input({ zones: [nightOwl] }));
    // 09:30Z is 12:30 in Sofia — out of the window, same local day.
    const later = produceDigest(
      input({ zones: [nightOwl], at: Date.parse('2026-08-20T09:30:00Z') }),
    );
    expect(later.outcome).toBe('send');
    expect(later.alertSubkey).toBe(held.windowStartIso);
  });

  it('holds if any zone is quiet, because one message goes to one reader', () => {
    const decision = produceDigest(input({ zones: [zone(), nightOwl] }));
    expect(decision.outcome).toBe('hold');
  });
});

describe('an empty window is spent, not held', () => {
  it('suppresses and moves on when nothing is active', () => {
    // "The digest naturally stops when nothing is active" (07 §5.5.3).
    const decision = produceDigest(input({ candidates: [] }));
    expect(decision.outcome).toBe('suppress');
    expect(decision.reason).toBe('nothing_active');
    expect(decision.advanceWatermark).toBe(true);
    expect(decision.entries).toEqual([]);
  });

  it('does not deliver it late when a fire starts after the window', () => {
    const empty = produceDigest(input({ candidates: [] }));
    const afternoon = produceDigest(
      input({ lastWindowStartIso: empty.windowStartIso, at: Date.parse('2026-08-20T12:00:00Z') }),
    );
    expect(afternoon.outcome).toBe('none');
  });
});

describe('who is owed a line', () => {
  const at = Date.parse('2026-08-20T06:00:00Z');
  const windowStart = at;

  it('carries a deferral made since the previous window', () => {
    const decision = produceDigest(
      input({
        lastWindowStartIso: '2026-08-19T06:00:00Z',
        candidates: [candidate({ kind: 'deferred', since: Date.parse('2026-08-19T23:00:00Z') })],
      }),
    );
    expect(decision.entries).toHaveLength(1);
    expect(decision.entries[0]?.kind).toBe('deferred');
  });

  it('does not re-report a deferral the previous window already carried', () => {
    const decision = produceDigest(
      input({
        lastWindowStartIso: '2026-08-19T06:00:00Z',
        candidates: [candidate({ kind: 'deferred', since: Date.parse('2026-08-19T04:00:00Z') })],
      }),
    );
    expect(decision.outcome).toBe('suppress');
  });

  it('carries a seed from before the window opened (A1.8)', () => {
    const decision = produceDigest(
      input({ candidates: [candidate({ kind: 'seeded', since: windowStart - 1 })] }),
    );
    expect(decision.entries).toHaveLength(1);
  });

  it('holds a seed made after the window opened until the next one', () => {
    // A zone drawn at 09:30 does not get its pre-existing fires summarised by a tick that
    // arrives at 09:40 — A1.8 makes it eligible "from the next window".
    const decision = produceDigest(
      input({
        at: Date.parse('2026-08-20T06:40:00Z'),
        candidates: [candidate({ kind: 'seeded', since: Date.parse('2026-08-20T06:30:00Z') })],
      }),
    );
    expect(decision.outcome).toBe('suppress');

    const tomorrow = produceDigest(
      input({
        at: Date.parse('2026-08-21T06:00:00Z'),
        lastWindowStartIso: '2026-08-20T06:00:00Z',
        candidates: [candidate({ kind: 'seeded', since: Date.parse('2026-08-20T06:30:00Z') })],
      }),
    );
    expect(tomorrow.outcome).toBe('send');
  });
});

describe('one fire is one line (A1.12)', () => {
  it('renders a multi-zone event from the nearest zone', () => {
    const decision = produceDigest(
      input({
        zones: [zone({ zoneId: 'zone-far' }), zone({ zoneId: 'zone-near' })],
        candidates: [
          candidate({ zoneId: 'zone-far', distanceKm: 9.8 }),
          candidate({ zoneId: 'zone-near', distanceKm: 3.2 }),
        ],
      }),
    );
    expect(decision.entries).toEqual([
      { zoneId: 'zone-near', eventPublicId: 'fw-2026-aaaa', distanceKm: 3.2, kind: 'active' },
    ]);
  });

  it('breaks an exact tie by zone id, the way the alert path does', () => {
    const decision = produceDigest(
      input({
        zones: [zone({ zoneId: 'zone-b' }), zone({ zoneId: 'zone-a' })],
        candidates: [
          candidate({ zoneId: 'zone-b', distanceKm: 4 }),
          candidate({ zoneId: 'zone-a', distanceKm: 4 }),
        ],
      }),
    );
    expect(decision.entries[0]?.zoneId).toBe('zone-a');
  });

  it('orders the message nearest-first, and by event id when equidistant', () => {
    const decision = produceDigest(
      input({
        candidates: [
          candidate({ eventPublicId: 'fw-2026-cccc', distanceKm: 12 }),
          candidate({ eventPublicId: 'fw-2026-bbbb', distanceKm: 2 }),
          candidate({ eventPublicId: 'fw-2026-aaaa', distanceKm: 12 }),
        ],
      }),
    );
    expect(decision.entries.map((entry) => entry.eventPublicId)).toEqual([
      'fw-2026-bbbb',
      'fw-2026-aaaa',
      'fw-2026-cccc',
    ]);
  });

  it('does not care what order the candidates arrive in', () => {
    const candidates = [
      candidate({ zoneId: 'zone-near', eventPublicId: 'fw-2026-bbbb', distanceKm: 3.2 }),
      candidate({ zoneId: 'zone-far', eventPublicId: 'fw-2026-bbbb', distanceKm: 9.8 }),
      candidate({ zoneId: 'zone-far', eventPublicId: 'fw-2026-aaaa', distanceKm: 9.8 }),
    ];
    const forwards = produceDigest(input({ candidates }));
    const backwards = produceDigest(input({ candidates: [...candidates].reverse() }));
    expect(backwards.entries).toEqual(forwards.entries);
  });
});

describe('data faults fail loudly', () => {
  it('refuses an account with no zones', () => {
    expect(() => produceDigest(input({ zones: [] }))).toThrow(RangeError);
  });

  it('refuses zones that disagree on the timezone A1.7 stores per account', () => {
    expect(() =>
      produceDigest(
        input({ zones: [zone(), zone({ zoneId: 'zone-b', timezone: 'Europe/Athens' })] }),
      ),
    ).toThrow(RangeError);
  });
});
