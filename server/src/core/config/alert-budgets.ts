/**
 * `alert_budgets_v1` — ADR-004 D5's fail-closed machinery, expressed as numbers.
 *
 * D5 is four sentences, and every one of them is a ceiling on how much harm one bug can
 * do before a human notices: **B = 500** automatic sends per event, **G = 2,000** sends
 * per 10 min globally, an anomaly breaker at `max(5x seasonal baseline, floor)`, and a
 * kill switch. A1.4 adds the caps on the solo-approval fallback that releases the sends B
 * held back, and A1.12 adds the deadline at which a held-back decision pages someone.
 *
 * **A separate config from `alert_gating_v1`, deliberately.** The gating version is
 * stamped on every `alert_outbox` row as `rule_version` and pinned by every alert
 * fixture's manifest, so it must move only when the *decision* moves. These numbers are
 * not part of the decision that a fire is worth telling someone about; they are the limit
 * on how many people that decision may reach before a second human is in the loop. They
 * also have a different owner and a different cadence — D5 puts them under change control
 * ("config-in-git, changed only by PR"), and 05's A2 is the review that signs them off.
 * The repo already answers this question the same way everywhere else: one small versioned
 * set per decision (`clustering_params`, `lifecycle_params`, `delivery_params`,
 * `digest_params`, `ingest_anomaly`, `qa_metrics`, ...).
 *
 * **"No runtime knob can raise them" is structural here, not documentary.** Every
 * consumer of these numbers takes a whole {@link AlertBudgetParams} so that a replay can
 * run last September under last September's ceilings — which is exactly the hole a
 * runtime knob would come through. {@link clampToShipped} closes it: a caller-supplied
 * parameter set is folded field by field towards the *stricter* of itself and the values
 * compiled in from git, so a supplied `B = 5000` enforces 500 and a supplied window of
 * one minute enforces ten. The direction of "stricter" is per field and is not always
 * "smaller" — a shorter G window with the same G is more permissive, not less — so each
 * field below states its safe direction and {@link clampToShipped} follows it.
 *
 * **What is missing, and is a blocker rather than an omission.** D5 writes the breaker's
 * threshold as `max(5x seasonal baseline, floor)` and never gives the floor a value; A1.5
 * says the sibling ingest leg needs "an absolute floor so a small denominator cannot trip
 * it" and gives no number either; 05 §5.2.3 restates the formula ("suggested k=5") and
 * leaves the floor as the words "absolute floor". No document in this repo pins it. It is
 * not a decoration: with no floor the threshold on a quiet April evening is five times a
 * baseline of two, and the first real fire of the season halts dispatch. So
 * `breaker.floorSendsPerWindow` ships as `null`, {@link dispatchAllowance} reports the
 * breaker as `unarmed` while it stays `null`, and G remains the only enforced ceiling on
 * a runaway — which is the ceiling D5 says the breaker exists to trip *before*, so the
 * outer guard holds while the inner one is unset. Pinning it is a founder/security call
 * (05 A2), and pinning it is a version bump of this file.
 *
 * There is no "seasonal baseline" number here either, and there is no sampling rule for
 * one: A1.5 defines a baseline only for the ingest leg (median of a source's last 14
 * same-hour batches) and D5's dispatch leg names a "seasonal baseline" without saying
 * what it is measured over. The baseline is therefore an argument to the breaker, supplied
 * by whoever can measure sends, and not a value this config claims to know.
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';

/** The dispatch-rate breaker's shape (D5; sibling of A1.5's ingest leg). */
export interface BreakerParams {
  /**
   * Multiples of the seasonal baseline at which dispatch halts. Five, from D5's
   * `max(5x seasonal baseline, floor)` and 05 §5.2.3's "suggested k=5".
   *
   * Safe direction: **smaller**. A larger multiple trips later, so a caller may lower it
   * and never raise it.
   */
  readonly ratio: number;
  /**
   * The absolute send count per {@link AlertBudgetParams.globalWindowMs} below which the
   * ratio leg cannot trip, or `null` while no document pins it (see the module header).
   *
   * Safe direction: **smaller**, and `null` is the *loosest* value rather than the
   * strictest — a `null` floor leaves the breaker unarmed, so a caller may arm it or
   * lower an armed floor, and may never disarm one.
   */
  readonly floorSendsPerWindow: number | null;
}

/** A1.4 §3's caps on the solo fallback that releases what B deferred. */
export interface SelfApprovalCaps {
  /** "one self-approval per event". Safe direction: smaller. */
  readonly perEvent: number;
  /** "<= 2 per rolling 24 h". Safe direction: smaller. */
  readonly perWindow: number;
  /** The "rolling 24 h" that count is taken over. Safe direction: **larger**. */
  readonly windowMs: number;
}

export interface AlertBudgetParams {
  /**
   * D5's **B**: "500 users notified per event automatically; beyond that the event's
   * remaining sends require T-approve". Per event and cumulative across the decision
   * transactions of that event — a fire that grows all afternoon does not get a fresh 500
   * every time a new detection lands, which is why {@link import('../alerts/budget-cutoff.js').applyBudgetCutoff}
   * continues an event's rank sequence rather than restarting it.
   *
   * Safe direction: smaller.
   */
  readonly perEventAutoSends: number;
  /**
   * D5's **G**: "2,000 sends per 10 min globally, auto-enforced".
   *
   * Safe direction: smaller.
   */
  readonly globalWindowSends: number;
  /**
   * The 10 minutes G is measured over, in milliseconds.
   *
   * Safe direction: **larger**. The same G over a shorter window is a higher send rate,
   * so shortening the window raises the ceiling even though the number G did not move.
   */
  readonly globalWindowMs: number;
  readonly breaker: BreakerParams;
  readonly selfApprovalCaps: SelfApprovalCaps;
  /**
   * A1.12's page: "oldest awaiting row > 30 min (a mass-notification decision is waiting
   * on a human)". Thirty minutes as milliseconds.
   *
   * It collides numerically with D6's 1800 s push TTL and shares nothing else with it:
   * that one is how long a push stays worth sending, this one is how long a human may
   * leave a deferred mass-notification unanswered. They are two 30-minute numbers with
   * two reasons, and folding them into one would make a channel TTL change silently move
   * a paging threshold.
   *
   * Safe direction: smaller — a shorter deadline pages sooner.
   */
  readonly approvalPendingPageMs: number;
}

const SHIPPED: AlertBudgetParams = {
  perEventAutoSends: 500,
  globalWindowSends: 2_000,
  globalWindowMs: 600_000,
  breaker: Object.freeze({ ratio: 5, floorSendsPerWindow: null }),
  selfApprovalCaps: Object.freeze({ perEvent: 1, perWindow: 2, windowMs: 86_400_000 }),
  approvalPendingPageMs: 1_800_000,
};

/**
 * The budgets as they stand in git.
 *
 * `defineConfig` freezes the top level; the two nested objects are frozen above, because a
 * shallow freeze on a config whose whole point is that nothing at runtime may raise it
 * would leave `ALERT_BUDGETS.values.breaker.ratio = 1e9` working.
 */
export const ALERT_BUDGETS: VersionedConfig<AlertBudgetParams> = defineConfig(
  'alert_budgets',
  'alert_budgets_v1',
  SHIPPED,
);

/**
 * Fold a caller-supplied parameter set towards the stricter of itself and the shipped
 * numbers, field by field.
 *
 * This is D5's "no runtime knob can raise them" made mechanical. Every consumer in this
 * package runs its input through here before enforcing anything, so the only way to send
 * to more than 500 recipients on one event, or more than 2,000 people in ten minutes, is
 * to change {@link SHIPPED} — which is a diff, a review and a version bump, which is what
 * "config-in-git, changed only by PR" means.
 *
 * A replay that needs *last* season's lower ceilings passes them and gets them. A replay
 * that needs last season's *higher* ceilings cannot have them, and that is not a
 * limitation to route around: it would mean the current build can be made to send more
 * than the current build's reviewed limit by handing it an old config file.
 */
export function clampToShipped(
  params: AlertBudgetParams,
  shipped: AlertBudgetParams = ALERT_BUDGETS.values,
): AlertBudgetParams {
  return {
    perEventAutoSends: Math.min(params.perEventAutoSends, shipped.perEventAutoSends),
    globalWindowSends: Math.min(params.globalWindowSends, shipped.globalWindowSends),
    globalWindowMs: Math.max(params.globalWindowMs, shipped.globalWindowMs),
    breaker: {
      ratio: Math.min(params.breaker.ratio, shipped.breaker.ratio),
      floorSendsPerWindow: strictestFloor(
        params.breaker.floorSendsPerWindow,
        shipped.breaker.floorSendsPerWindow,
      ),
    },
    selfApprovalCaps: {
      perEvent: Math.min(params.selfApprovalCaps.perEvent, shipped.selfApprovalCaps.perEvent),
      perWindow: Math.min(params.selfApprovalCaps.perWindow, shipped.selfApprovalCaps.perWindow),
      windowMs: Math.max(params.selfApprovalCaps.windowMs, shipped.selfApprovalCaps.windowMs),
    },
    approvalPendingPageMs: Math.min(params.approvalPendingPageMs, shipped.approvalPendingPageMs),
  };
}

/**
 * The lower of two floors, where `null` means "no floor at all" and therefore loses to any
 * number: an unarmed breaker is the loosest setting, so arming one is always a tightening
 * and disarming one is never allowed.
 */
function strictestFloor(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Math.min(a, b);
}

export function assertAlertBudgetParams(params: AlertBudgetParams): void {
  for (const [name, value] of [
    ['perEventAutoSends', params.perEventAutoSends],
    ['globalWindowSends', params.globalWindowSends],
    ['globalWindowMs', params.globalWindowMs],
    ['selfApprovalCaps.perEvent', params.selfApprovalCaps.perEvent],
    ['selfApprovalCaps.perWindow', params.selfApprovalCaps.perWindow],
    ['selfApprovalCaps.windowMs', params.selfApprovalCaps.windowMs],
    ['approvalPendingPageMs', params.approvalPendingPageMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`alert budget ${name} must be a positive integer, got ${String(value)}`);
    }
  }
  if (!Number.isFinite(params.breaker.ratio) || params.breaker.ratio <= 1) {
    throw new RangeError(
      `alert budget breaker ratio must be greater than 1, got ${String(params.breaker.ratio)}; ` +
        'a ratio of 1 or less halts dispatch on any day busier than the baseline',
    );
  }
  const floor = params.breaker.floorSendsPerWindow;
  if (floor !== null) {
    if (!Number.isInteger(floor) || floor < 1) {
      throw new RangeError(
        `alert budget breaker floor must be a positive integer or null, got ${String(floor)}`,
      );
    }
    // D5: the breaker exists so that "a runaway bug trips it before budget G exhausts". A
    // floor at or above G is a breaker that can only trip after the ceiling it was meant
    // to protect has already been hit, i.e. one that has no effect at all.
    if (floor >= params.globalWindowSends) {
      throw new RangeError(
        `alert budget breaker floor (${String(floor)}) must be below the global window budget ` +
          `(${String(params.globalWindowSends)}); a floor at or above G trips only after G has ` +
          'already stopped dispatch',
      );
    }
  }
  if (params.selfApprovalCaps.perEvent > params.selfApprovalCaps.perWindow) {
    throw new RangeError(
      `alert budget selfApprovalCaps.perEvent (${String(params.selfApprovalCaps.perEvent)}) ` +
        `cannot exceed perWindow (${String(params.selfApprovalCaps.perWindow)}); the per-event ` +
        'cap would be unreachable',
    );
  }
}
