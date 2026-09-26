import { describe, expect, it } from 'vitest';

import { applyBudgetCutoff, compareIdentity, type BudgetCandidate } from './budget-cutoff.js';
import { ALERT_BUDGETS, type AlertBudgetParams } from '../config/alert-budgets.js';

/** One decision instant for the whole batch, as a real decision transaction has. */
const DECIDED_AT = Date.UTC(2026, 7, 14, 12, 0, 0);

/** A1.2's `new_fire` priority — the same integer `priorityFor('new_fire')` returns. */
const NEW_FIRE = 10;

function batch(count: number, from = 1): BudgetCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    identity: String(from + index),
    priority: NEW_FIRE,
    decidedAt: DECIDED_AT,
  }));
}

function budgets(patch: Partial<AlertBudgetParams>): AlertBudgetParams {
  return { ...ALERT_BUDGETS.values, ...patch };
}

describe('applyBudgetCutoff — A1.12 at B = 500', () => {
  it('releases the first 500 and defers the rest', () => {
    // 502 recipients, one decision: ranks 1..502, of which 1..500 are <= B and release,
    // and 501, 502 wait for T-approve. 502 - 500 = 2 deferred.
    const cutoff = applyBudgetCutoff(batch(502));

    expect(cutoff.budget).toBe(500);
    expect(cutoff.ranked).toHaveLength(502);
    expect(cutoff.released).toBe(500);
    expect(cutoff.deferred).toBe(2);
    expect(cutoff.nextSeq).toBe(502);
    expect(cutoff.ranked[0]).toEqual({ identity: '1', budgetSeq: 1, status: 'pending' });
    expect(cutoff.ranked[499]).toEqual({ identity: '500', budgetSeq: 500, status: 'pending' });
    expect(cutoff.ranked[500]).toEqual({
      identity: '501',
      budgetSeq: 501,
      status: 'awaiting_approval',
    });
    expect(cutoff.ranked[501]?.status).toBe('awaiting_approval');
  });

  it('continues the rank sequence of one event across decision transactions', () => {
    // A fire that grows all afternoon decides several times. B is a per-*event* ceiling, so
    // the second transaction starts at 499 and only two of its five rows are still inside
    // 500: ranks 499, 500 release; 501, 502, 503 defer.
    const cutoff = applyBudgetCutoff(batch(5, 600), { previouslyRanked: 498 });

    expect(cutoff.ranked.map((row) => row.budgetSeq)).toEqual([499, 500, 501, 502, 503]);
    expect(cutoff.released).toBe(2);
    expect(cutoff.deferred).toBe(3);
    expect(cutoff.nextSeq).toBe(503);
  });

  it('defers everything once the event has spent B', () => {
    const cutoff = applyBudgetCutoff(batch(3, 900), { previouslyRanked: 500 });

    expect(cutoff.released).toBe(0);
    expect(cutoff.deferred).toBe(3);
    expect(cutoff.ranked.every((row) => row.status === 'awaiting_approval')).toBe(true);
  });

  it('ranks nothing and moves nothing when there is nothing to rank', () => {
    const cutoff = applyBudgetCutoff([], { previouslyRanked: 12 });

    expect(cutoff.ranked).toEqual([]);
    expect(cutoff.released).toBe(0);
    expect(cutoff.deferred).toBe(0);
    expect(cutoff.nextSeq).toBe(12);
  });

  it('is reproducible from the rows alone, in any argument order', () => {
    // "The cut is therefore reproducible from the rows alone in replay and audit."
    const rows = batch(12);
    const shuffled = [
      rows[7],
      rows[0],
      rows[11],
      ...rows.filter((_, i) => ![0, 7, 11].includes(i)),
    ];

    expect(applyBudgetCutoff(shuffled as BudgetCandidate[])).toEqual(applyBudgetCutoff(rows));
  });
});

describe('decision order — (priority, decided_at, id)', () => {
  it('puts a manual broadcast ahead of an earlier automatic alert', () => {
    // A1.2's priorities: manual = 0, new_fire = 10. Priority is the first term, so a manual
    // row decided a minute later still ranks first.
    const cutoff = applyBudgetCutoff([
      { identity: '1', priority: NEW_FIRE, decidedAt: DECIDED_AT },
      { identity: '2', priority: 0, decidedAt: DECIDED_AT + 60_000 },
    ]);

    expect(cutoff.ranked.map((row) => row.identity)).toEqual(['2', '1']);
  });

  it('orders equal priorities by decision instant', () => {
    const cutoff = applyBudgetCutoff([
      { identity: '2', priority: NEW_FIRE, decidedAt: DECIDED_AT + 1 },
      { identity: '1', priority: NEW_FIRE, decidedAt: DECIDED_AT },
    ]);

    expect(cutoff.ranked.map((row) => row.identity)).toEqual(['1', '2']);
  });

  it('compares bigint row ids numerically, the way Postgres orders them', () => {
    // The bug this exists for: as text, '10' < '9' and '100' < '9', so a string sort would
    // rank row 100 second and row 9 last — a cut that disagrees with the queue's
    // ORDER BY priority, decided_at, id on every event past the ninth recipient.
    const cutoff = applyBudgetCutoff([
      { identity: '10', priority: NEW_FIRE, decidedAt: DECIDED_AT },
      { identity: '9', priority: NEW_FIRE, decidedAt: DECIDED_AT },
      { identity: '100', priority: NEW_FIRE, decidedAt: DECIDED_AT },
    ]);

    expect(cutoff.ranked.map((row) => row.identity)).toEqual(['9', '10', '100']);
  });

  it('compares uuid zone ids lexicographically', () => {
    const cutoff = applyBudgetCutoff([
      {
        identity: 'b0000000-0000-4000-8000-000000000001',
        priority: NEW_FIRE,
        decidedAt: DECIDED_AT,
      },
      {
        identity: 'a0000000-0000-4000-8000-000000000009',
        priority: NEW_FIRE,
        decidedAt: DECIDED_AT,
      },
    ]);

    expect(cutoff.ranked.map((row) => row.identity)).toEqual([
      'a0000000-0000-4000-8000-000000000009',
      'b0000000-0000-4000-8000-000000000001',
    ]);
  });

  it('reads a padded decimal id as the number it is', () => {
    expect(compareIdentity('007', '7')).toBe(0);
    expect(compareIdentity('0', '00')).toBe(0);
  });

  it('refuses to order a row id against a zone id', () => {
    expect(() => compareIdentity('42', 'a0000000-0000-4000-8000-000000000009')).toThrow(TypeError);
  });
});

describe('inputs that would make the cut unreproducible', () => {
  it('rejects a duplicated identity', () => {
    expect(() =>
      applyBudgetCutoff([
        { identity: '1', priority: NEW_FIRE, decidedAt: DECIDED_AT },
        { identity: '1', priority: NEW_FIRE, decidedAt: DECIDED_AT + 5 },
      ]),
    ).toThrow(TypeError);
  });

  it('rejects a non-finite decision instant and a fractional priority', () => {
    expect(() =>
      applyBudgetCutoff([{ identity: '1', priority: NEW_FIRE, decidedAt: Number.NaN }]),
    ).toThrow(RangeError);
    expect(() =>
      applyBudgetCutoff([{ identity: '1', priority: 10.5, decidedAt: DECIDED_AT }]),
    ).toThrow(RangeError);
  });

  it('rejects a negative starting rank', () => {
    expect(() => applyBudgetCutoff(batch(1), { previouslyRanked: -1 })).toThrow(RangeError);
  });

  it('refuses to order two identities of different kinds inside one batch', () => {
    expect(() =>
      applyBudgetCutoff([
        { identity: '1', priority: NEW_FIRE, decidedAt: DECIDED_AT },
        {
          identity: 'a0000000-0000-4000-8000-000000000009',
          priority: NEW_FIRE,
          decidedAt: DECIDED_AT,
        },
      ]),
    ).toThrow(TypeError);
  });
});

describe('the ceiling is not a runtime knob', () => {
  it('ignores a caller-supplied B larger than the one in git', () => {
    // D5: "no runtime knob can raise them". 502 candidates against a claimed B of 5,000
    // still cut at 500.
    const cutoff = applyBudgetCutoff(batch(502), {
      params: budgets({ perEventAutoSends: 5_000 }),
    });

    expect(cutoff.budget).toBe(500);
    expect(cutoff.released).toBe(500);
    expect(cutoff.deferred).toBe(2);
  });

  it('honours a caller-supplied B smaller than the one in git', () => {
    const cutoff = applyBudgetCutoff(batch(12), { params: budgets({ perEventAutoSends: 10 }) });

    expect(cutoff.budget).toBe(10);
    expect(cutoff.released).toBe(10);
    expect(cutoff.deferred).toBe(2);
  });
});
