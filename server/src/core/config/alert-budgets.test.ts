import { describe, expect, it } from 'vitest';

import {
  ALERT_BUDGETS,
  assertAlertBudgetParams,
  clampToShipped,
  type AlertBudgetParams,
} from './alert-budgets.js';

/** The shipped set with one field bent, for the clamp tests. */
function budgets(patch: Partial<AlertBudgetParams>): AlertBudgetParams {
  return { ...ALERT_BUDGETS.values, ...patch };
}

describe('alert_budgets_v1', () => {
  it('cites a version a stored decision can be read against', () => {
    expect(ALERT_BUDGETS.version).toBe('alert_budgets_v1');
    expect(ALERT_BUDGETS.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('pins the digest, because a refit that forgot to bump the version is invisible', () => {
    // Same reason `alert_gating_v1` pins one: D5 puts these numbers under "changed only by
    // PR", and a version that stayed still while a ceiling moved would let an archived
    // decision claim it was made under limits that were not in force.
    expect(ALERT_BUDGETS.digest).toBe('8107d13e');
  });

  it('pins B and G exactly as D5 writes them', () => {
    // D5: "B = 500 users notified per event automatically"; "G = 2,000 sends per 10 min
    // globally". 10 min = 600_000 ms.
    expect(ALERT_BUDGETS.values.perEventAutoSends).toBe(500);
    expect(ALERT_BUDGETS.values.globalWindowSends).toBe(2_000);
    expect(ALERT_BUDGETS.values.globalWindowMs).toBe(600_000);
    expect(ALERT_BUDGETS.values.globalWindowMs / 60_000).toBe(10);
  });

  it('pins the breaker ratio at 5 and leaves the floor unset, because no document sets it', () => {
    // D5: "max(5x seasonal baseline, floor)"; 05 §5.2.3 restates it as "suggested k=5".
    // The floor has no value anywhere in the corpus — A1.5 asks for "an absolute floor so a
    // small denominator cannot trip it" without naming one. `null` is that absence, and it
    // is asserted rather than tolerated so that pinning a floor is a deliberate edit here.
    expect(ALERT_BUDGETS.values.breaker.ratio).toBe(5);
    expect(ALERT_BUDGETS.values.breaker.floorSendsPerWindow).toBeNull();
  });

  it("pins A1.4's caps on the solo fallback", () => {
    // A1.4 §3: "caps: one self-approval per event, <= 2 per rolling 24 h".
    // 24 h = 86_400_000 ms.
    expect(ALERT_BUDGETS.values.selfApprovalCaps.perEvent).toBe(1);
    expect(ALERT_BUDGETS.values.selfApprovalCaps.perWindow).toBe(2);
    expect(ALERT_BUDGETS.values.selfApprovalCaps.windowMs).toBe(86_400_000);
    expect(ALERT_BUDGETS.values.selfApprovalCaps.windowMs / 3_600_000).toBe(24);
  });

  it("pins A1.12's 30-minute approval page", () => {
    // A1.12: "Pages: oldest awaiting row > 30 min". 30 min = 1_800_000 ms.
    expect(ALERT_BUDGETS.values.approvalPendingPageMs).toBe(1_800_000);
  });

  it('freezes the nested objects, not only the top level', () => {
    // A shallow freeze on a config whose whole promise is "no runtime knob can raise them"
    // would leave `values.breaker.ratio = 1e9` working at runtime.
    expect(Object.isFrozen(ALERT_BUDGETS.values)).toBe(true);
    expect(Object.isFrozen(ALERT_BUDGETS.values.breaker)).toBe(true);
    expect(Object.isFrozen(ALERT_BUDGETS.values.selfApprovalCaps)).toBe(true);
  });

  it('is internally consistent', () => {
    expect(() => assertAlertBudgetParams(ALERT_BUDGETS.values)).not.toThrow();
  });
});

describe('clampToShipped — D5 "no runtime knob can raise them"', () => {
  it('refuses a larger B or G', () => {
    const clamped = clampToShipped(
      budgets({ perEventAutoSends: 5_000, globalWindowSends: 100_000 }),
    );
    expect(clamped.perEventAutoSends).toBe(500);
    expect(clamped.globalWindowSends).toBe(2_000);
  });

  it('refuses a shorter G window, which raises the rate without touching G', () => {
    // 2,000 sends per 60 s is ten times the ceiling 2,000 sends per 600 s allows, so
    // "stricter" for this field is the longer window.
    expect(clampToShipped(budgets({ globalWindowMs: 60_000 })).globalWindowMs).toBe(600_000);
  });

  it('accepts stricter values, because a replay of a smaller season is legitimate', () => {
    const clamped = clampToShipped(
      budgets({ perEventAutoSends: 100, globalWindowSends: 500, globalWindowMs: 1_200_000 }),
    );
    expect(clamped.perEventAutoSends).toBe(100);
    expect(clamped.globalWindowSends).toBe(500);
    expect(clamped.globalWindowMs).toBe(1_200_000);
  });

  it('refuses a looser breaker but lets a caller arm one', () => {
    const clamped = clampToShipped(budgets({ breaker: { ratio: 50, floorSendsPerWindow: 300 } }));
    // A bigger multiple trips later, so the ratio clamps down to the shipped 5.
    expect(clamped.breaker.ratio).toBe(5);
    // The shipped floor is `null` — no floor at all — and arming a breaker can only stop
    // more sends than shipping without one, so the caller's floor stands.
    expect(clamped.breaker.floorSendsPerWindow).toBe(300);
  });

  it('refuses to disarm or raise a floor that is shipped', () => {
    const shipped = budgets({ breaker: { ratio: 5, floorSendsPerWindow: 300 } });
    expect(clampToShipped(budgets({}), shipped).breaker.floorSendsPerWindow).toBe(300);
    expect(
      clampToShipped(budgets({ breaker: { ratio: 5, floorSendsPerWindow: 900 } }), shipped).breaker
        .floorSendsPerWindow,
    ).toBe(300);
    expect(
      clampToShipped(budgets({ breaker: { ratio: 5, floorSendsPerWindow: 120 } }), shipped).breaker
        .floorSendsPerWindow,
    ).toBe(120);
  });

  it("refuses to loosen A1.4's caps or lengthen A1.12's page deadline", () => {
    const clamped = clampToShipped(
      budgets({
        selfApprovalCaps: { perEvent: 5, perWindow: 20, windowMs: 3_600_000 },
        approvalPendingPageMs: 7_200_000,
      }),
    );
    expect(clamped.selfApprovalCaps).toEqual({ perEvent: 1, perWindow: 2, windowMs: 86_400_000 });
    expect(clamped.approvalPendingPageMs).toBe(1_800_000);
  });
});

describe('assertAlertBudgetParams', () => {
  it('rejects a ratio of 1 or less, which halts dispatch on any busy day', () => {
    expect(() =>
      assertAlertBudgetParams(budgets({ breaker: { ratio: 1, floorSendsPerWindow: null } })),
    ).toThrow(RangeError);
  });

  it('rejects a floor at or above G, which could only trip after G already stopped dispatch', () => {
    // D5 says the breaker exists so "a runaway bug trips it before budget G exhausts".
    expect(() =>
      assertAlertBudgetParams(budgets({ breaker: { ratio: 5, floorSendsPerWindow: 2_000 } })),
    ).toThrow(/must be below the global window budget/);
    expect(() =>
      assertAlertBudgetParams(budgets({ breaker: { ratio: 5, floorSendsPerWindow: 1_999 } })),
    ).not.toThrow();
  });

  it('rejects a non-positive or fractional budget', () => {
    expect(() => assertAlertBudgetParams(budgets({ perEventAutoSends: 0 }))).toThrow(RangeError);
    expect(() => assertAlertBudgetParams(budgets({ globalWindowSends: 12.5 }))).toThrow(RangeError);
  });

  it('rejects a per-event cap that its rolling window cannot reach', () => {
    expect(() =>
      assertAlertBudgetParams(
        budgets({ selfApprovalCaps: { perEvent: 3, perWindow: 2, windowMs: 86_400_000 } }),
      ),
    ).toThrow(/cannot exceed perWindow/);
  });
});
