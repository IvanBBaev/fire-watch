import { describe, expect, it } from 'vitest';

import {
  ALERT_STATES,
  alertStateRank,
  foldAlertStates,
  isNotified,
  type AlertState,
  type AlertStateRow,
} from './alert-state.js';

function row(overrides: Partial<AlertStateRow> & Pick<AlertStateRow, 'zoneId'>): AlertStateRow {
  return {
    eventPublicId: 'fw-2026-parent1',
    state: 'none',
    escalationWatermark: 0,
    seededAtIso: null,
    lastNotifiedAtIso: null,
    ...overrides,
  };
}

describe('the alert ladder', () => {
  it('ranks the states in the order ADR-004 D3 defines', () => {
    expect(ALERT_STATES.map(alertStateRank)).toEqual([0, 1, 2, 3]);
  });

  it('rejects a state that is not on the ladder', () => {
    expect(() => alertStateRank('notified' as AlertState)).toThrow(RangeError);
  });

  it('treats every state above `none` as notified', () => {
    expect(ALERT_STATES.filter(isNotified)).toEqual([
      'notified_new',
      'notified_escalation',
      'cooldown',
    ]);
  });

  it('keeps "most advanced" and "most suppressive" the same ordering', () => {
    // The fold takes one maximum and relies on it answering both questions. If a future
    // state is advanced but *less* suppressive than an earlier one, the fold has to be
    // re-derived — this assertion is where that shows up, rather than in a duplicate alert.
    const suppressiveness: Record<AlertState, number> = {
      none: 0,
      notified_new: 1,
      notified_escalation: 2,
      cooldown: 3,
    };
    expect(ALERT_STATES.map((state) => suppressiveness[state])).toEqual(
      ALERT_STATES.map(alertStateRank),
    );
  });
});

describe('foldAlertStates — I3: a merge never re-announces a known fire', () => {
  it('carries a notified parent onto a survivor that has no row of its own', () => {
    // The exact shape of the failure I3 forbids: the zone knows about the parent, the
    // survivor's row does not exist, and without the fold the next evaluation says "new".
    const folded = foldAlertStates(
      [
        row({
          zoneId: 'zone-blagoevgrad',
          eventPublicId: 'fw-2026-parent1',
          state: 'notified_new',
          lastNotifiedAtIso: '2026-08-08T11:00:00.000Z',
          seededAtIso: '2026-08-08T10:55:00.000Z',
        }),
      ],
      'fw-2026-surv',
      ['fw-2026-parent1'],
    );

    expect(folded).toEqual([
      {
        zoneId: 'zone-blagoevgrad',
        eventPublicId: 'fw-2026-surv',
        state: 'notified_new',
        escalationWatermark: 0,
        seededAtIso: '2026-08-08T10:55:00.000Z',
        lastNotifiedAtIso: '2026-08-08T11:00:00.000Z',
      },
    ]);
  });

  it('takes the most advanced state across all parents, in either order', () => {
    const notified = row({
      zoneId: 'z',
      eventPublicId: 'fw-2026-parent1',
      state: 'notified_escalation',
    });
    const quiet = row({ zoneId: 'z', eventPublicId: 'fw-2026-parent2', state: 'none' });

    for (const rows of [
      [notified, quiet],
      [quiet, notified],
    ]) {
      const [folded] = foldAlertStates(rows, 'fw-2026-surv', [
        'fw-2026-parent1',
        'fw-2026-parent2',
      ]);
      expect(folded?.state).toBe('notified_escalation');
    }
  });

  it('takes the highest escalation watermark — A1.11, never re-send a step', () => {
    const [folded] = foldAlertStates(
      [
        row({ zoneId: 'z', eventPublicId: 'fw-2026-parent1', escalationWatermark: 3 }),
        row({ zoneId: 'z', eventPublicId: 'fw-2026-parent2', escalationWatermark: 1 }),
      ],
      'fw-2026-surv',
      ['fw-2026-parent1', 'fw-2026-parent2'],
    );
    expect(folded?.escalationWatermark).toBe(3);
  });

  it('measures the suppression window from the most recent message actually sent', () => {
    const [folded] = foldAlertStates(
      [
        row({
          zoneId: 'z',
          eventPublicId: 'fw-2026-parent1',
          state: 'notified_new',
          lastNotifiedAtIso: '2026-08-08T09:00:00.000Z',
        }),
        row({
          zoneId: 'z',
          eventPublicId: 'fw-2026-parent2',
          state: 'notified_new',
          lastNotifiedAtIso: '2026-08-08T13:30:00.000Z',
        }),
      ],
      'fw-2026-surv',
      ['fw-2026-parent1', 'fw-2026-parent2'],
    );
    expect(folded?.lastNotifiedAtIso).toBe('2026-08-08T13:30:00.000Z');
  });

  it('keeps the earliest seeding — the survivor inherits the fire, not the row', () => {
    const [folded] = foldAlertStates(
      [
        row({
          zoneId: 'z',
          eventPublicId: 'fw-2026-parent1',
          seededAtIso: '2026-08-08T12:00:00.000Z',
        }),
        row({
          zoneId: 'z',
          eventPublicId: 'fw-2026-parent2',
          seededAtIso: '2026-08-07T18:20:00.000Z',
        }),
      ],
      'fw-2026-surv',
      ['fw-2026-parent1', 'fw-2026-parent2'],
    );
    expect(folded?.seededAtIso).toBe('2026-08-07T18:20:00.000Z');
  });

  it('compares instants, not strings', () => {
    // The clock port accepts minute precision as well as seconds, so two rows written by
    // two code paths can differ in shape and not only in value. `09:00Z` sorts *after*
    // `09:00:01Z` as text — `Z` is above `:` — while being a second earlier as an instant.
    // Sorting the text here would measure the suppression window from the wrong message.
    const [folded] = foldAlertStates(
      [
        row({
          zoneId: 'z',
          eventPublicId: 'fw-2026-parent1',
          lastNotifiedAtIso: '2026-08-08T09:00Z',
        }),
        row({
          zoneId: 'z',
          eventPublicId: 'fw-2026-parent2',
          lastNotifiedAtIso: '2026-08-08T09:00:01Z',
        }),
      ],
      'fw-2026-surv',
      ['fw-2026-parent1', 'fw-2026-parent2'],
    );
    expect(folded?.lastNotifiedAtIso).toBe('2026-08-08T09:00:01Z');
  });

  it('refuses a timestamp that is not an explicit UTC instant', () => {
    // Inherited from the clock port on purpose. A naive or offset timestamp compared here
    // would be read in the host's zone, and the fold would order two messages by where CI
    // happened to run.
    expect(() =>
      foldAlertStates(
        [
          row({
            zoneId: 'z',
            eventPublicId: 'fw-2026-parent1',
            lastNotifiedAtIso: '2026-08-08T09:00:00.000Z',
          }),
          row({
            zoneId: 'z',
            eventPublicId: 'fw-2026-parent2',
            lastNotifiedAtIso: '2026-08-08 09:00:00',
          }),
        ],
        'fw-2026-surv',
        ['fw-2026-parent1', 'fw-2026-parent2'],
      ),
    ).toThrow(RangeError);
  });

  it('treats a null timestamp as absent rather than as the beginning of time', () => {
    const [folded] = foldAlertStates(
      [
        row({ zoneId: 'z', eventPublicId: 'fw-2026-parent1', seededAtIso: null }),
        row({
          zoneId: 'z',
          eventPublicId: 'fw-2026-parent2',
          seededAtIso: '2026-08-07T18:20:00.000Z',
        }),
      ],
      'fw-2026-surv',
      ['fw-2026-parent1', 'fw-2026-parent2'],
    );
    expect(folded?.seededAtIso).toBe('2026-08-07T18:20:00.000Z');
  });

  it('emits one row per zone, ascending, and does not mix zones', () => {
    const folded = foldAlertStates(
      [
        row({ zoneId: 'zone-sofia', eventPublicId: 'fw-2026-parent1', state: 'cooldown' }),
        row({ zoneId: 'zone-burgas', eventPublicId: 'fw-2026-parent2', state: 'notified_new' }),
        row({ zoneId: 'zone-sofia', eventPublicId: 'fw-2026-parent2', state: 'none' }),
      ],
      'fw-2026-surv',
      ['fw-2026-parent1', 'fw-2026-parent2'],
    );

    expect(folded.map((entry) => [entry.zoneId, entry.state])).toEqual([
      ['zone-burgas', 'notified_new'],
      ['zone-sofia', 'cooldown'],
    ]);
  });

  it("keeps the survivor's own row in the fold", () => {
    const [folded] = foldAlertStates(
      [
        row({ zoneId: 'z', eventPublicId: 'fw-2026-surv', state: 'notified_new' }),
        row({ zoneId: 'z', eventPublicId: 'fw-2026-parent1', state: 'cooldown' }),
      ],
      'fw-2026-surv',
      ['fw-2026-parent1'],
    );
    expect(folded?.state).toBe('cooldown');
  });

  it('rejects a row belonging to neither the target nor a parent', () => {
    // Silently dropping it would move an unrelated zone's alert state nowhere and look like
    // it worked; folding it in would migrate a stranger's state onto this survivor.
    expect(() =>
      foldAlertStates([row({ zoneId: 'z', eventPublicId: 'fw-2026-other' })], 'fw-2026-surv', [
        'fw-2026-parent1',
      ]),
    ).toThrow(/fw-2026-other is not a parent of fw-2026-surv/);
  });

  it('folds nothing into nothing', () => {
    expect(foldAlertStates([], 'fw-2026-surv', ['fw-2026-parent1'])).toEqual([]);
  });
});
