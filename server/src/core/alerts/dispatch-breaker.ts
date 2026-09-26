/**
 * May the gateway claim anything at all right now - D5's kill switch, global budget G and
 * anomaly circuit breaker, as one pure verdict.
 *
 * These three are one function because they answer one question at one moment: the worker
 * is about to call `runOnce`, and something may have to stop it. They gate **claiming**,
 * not sending. `notification-gateway.ts` says the same thing from the other side ("the
 * three of them gate *claiming*"), and `dispatch-decision.ts` says why they are not also
 * re-checked per row: a second enforcement point would be a second place for the cut to
 * disagree with the `budget_seq` A1.12 stores precisely so it cannot.
 *
 * **A halt never drops a row.** Nothing here settles, expires or deletes anything - a
 * halt is the absence of a claim. D5 is explicit about why: "one command stops all
 * dispatch (outbox keeps accumulating decisions for post-mortem)". The outbox filling up
 * during a halt is the feature. What the rows then run into is D6's queue expiry, which is
 * a different clock owned by a different module and pages under A1.12 when it fires - so
 * a long halt is loud, but it is loud as dropped sends, not as lost decisions.
 *
 * **Fail-closed, and what that costs.** Every uncertain input halts: an unmeasurable send
 * rate halts because G cannot be enforced without it, and a breaker that tripped stays
 * tripped until a human clears it (05 §5.2.3, "Human closes the breaker explicitly"; A1.5
 * for the sibling ingest leg, "release is manual after inspection"). Halting is the safe
 * direction here and only here: the map fails open, alerts fail closed (05 A4).
 *
 * Malformed numbers throw rather than halt. A `NaN` send count is not a state the system
 * can be in, it is a caller bug, and the throw stops dispatch just as effectively as a
 * halt verdict would - the caller has no claim limit to claim with either way.
 *
 * **The breaker ships unarmed, and that is a reported gap, not a default.** Its threshold
 * is `max(5x seasonal baseline, floor)` and no document in this repo gives the floor a
 * value; see the header of `config/alert-budgets.ts`. With no floor the ratio leg alone
 * would halt dispatch at the first real fire of a quiet spring - five times a baseline of
 * two is ten - which is the exact "small denominator" failure A1.5 says the floor exists
 * to prevent. So while the floor is `null` the breaker reports `unarmed` and never trips,
 * and G remains the enforced ceiling: D5 describes the breaker as the guard that trips
 * "before budget G exhausts", so the outer limit is doing its job while the inner one is
 * unset.
 *
 * **What is not here: where the two switch positions are stored.** The kill switch is
 * "one command" and the breaker's latch survives a worker restart, so both live in a
 * store an adapter owns and are handed in as {@link DispatchControlState}. Core holds no
 * state, no clock and no I/O; it holds the rule that reads them.
 */

import {
  ALERT_BUDGETS,
  clampToShipped,
  type AlertBudgetParams,
  type BreakerParams,
} from '../config/alert-budgets.js';

/**
 * The two positions an operator can put dispatch in, as the gateway sees them.
 *
 * Both are set by a human and cleared by a human. Neither has a timeout: a kill switch
 * that reopened on its own would defeat the point of a kill switch, and a breaker that
 * reset itself would re-enter the storm it stopped.
 */
export interface DispatchControlState {
  /** D5's kill switch, engaged. One command stops all dispatch. */
  readonly killSwitch: boolean;
  /**
   * A previous {@link DispatchAllowance} tripped the breaker and no one has closed it
   * since. Persisted by the caller, because a trip that a worker restart forgets is not a
   * breaker.
   */
  readonly breakerLatched: boolean;
}

export interface DispatchAllowanceInput {
  readonly control: DispatchControlState;
  /**
   * Sends made in the trailing {@link AlertBudgetParams.globalWindowMs}, or `null` when
   * that cannot be measured right now. `null` halts: an unenforceable ceiling is not a
   * ceiling.
   */
  readonly sendsInWindow: number | null;
  /**
   * D5's "seasonal baseline", in sends per the same window as G, or `null` when there is
   * not enough history to have one.
   *
   * No document defines how this is sampled. A1.5 defines a baseline for the *ingest* leg
   * (median of a source's last 14 same-hour batches) and D5's dispatch leg says only
   * "seasonal baseline". Rather than invent a sampling rule in core, the measurement is
   * the caller's and the rule is here.
   */
  readonly baselineSendsPerWindow: number | null;
  /** How many rows the worker would claim if nothing stopped it. */
  readonly batchSize: number;
  readonly params?: AlertBudgetParams;
}

export type DispatchHaltReason =
  | 'kill_switch'
  | 'breaker_latched'
  | 'send_rate_anomaly'
  | 'global_budget_exhausted'
  | 'unknown_send_rate';

/** What the breaker could say about itself at the moment of the verdict. */
export type BreakerState = 'unarmed' | 'armed' | 'tripped' | 'latched';

export interface BreakerReading {
  readonly state: BreakerState;
  /** Sends per window above which the breaker trips, or `null` while unarmed. */
  readonly threshold: number | null;
  readonly baseline: number | null;
  readonly ratio: number;
  readonly floor: number | null;
}

export type DispatchAllowance =
  | {
      readonly state: 'halted';
      readonly reason: DispatchHaltReason;
      /**
       * Whether this halt is an incident. Every halt except the kill switch is - a
       * deliberate stop needs no page, and a silent stop is the worst failure this
       * product has: alerts stop and nobody finds out. D5 pages on a breaker trip, 05 A2
       * pages on exceeding B or G.
       */
      readonly pages: boolean;
      /** Human-readable, for the log line next to the halt. Never parsed. */
      readonly detail: string;
      readonly breaker: BreakerReading;
    }
  | {
      readonly state: 'open';
      /**
       * How many rows may be claimed this cycle: the caller's batch size, capped by the
       * headroom left under G and, when the breaker is armed, by the headroom left under
       * its threshold. Claiming past either would trip on the next cycle a guard that is
       * currently holding.
       *
       * It can legitimately be `0` - a guard that is holding without having tripped, e.g.
       * a send count sitting exactly on the breaker threshold. The verdict stays `open`
       * rather than `halted` because nothing is wrong and nothing needs a human: the next
       * cycle, with an older window, will have headroom again.
       */
      readonly claimLimit: number;
      readonly breaker: BreakerReading;
    };

/**
 * The threshold D5 writes as `max(5x seasonal baseline, floor)`, or `null` while the
 * breaker is unarmed.
 *
 * With a floor and no baseline the floor stands alone, which is the intended reading: the
 * floor is what a breaker with no history to compare against still has.
 */
export function breakerThreshold(baseline: number | null, breaker: BreakerParams): number | null {
  if (breaker.floorSendsPerWindow === null) {
    return null;
  }
  if (baseline === null) {
    return breaker.floorSendsPerWindow;
  }
  return Math.max(breaker.ratio * baseline, breaker.floorSendsPerWindow);
}

export function dispatchAllowance(input: DispatchAllowanceInput): DispatchAllowance {
  const params = clampToShipped(input.params ?? ALERT_BUDGETS.values);
  assertCount('batchSize', input.batchSize, 1);
  if (input.sendsInWindow !== null) {
    assertCount('sendsInWindow', input.sendsInWindow, 0);
  }
  if (input.baselineSendsPerWindow !== null) {
    if (!Number.isFinite(input.baselineSendsPerWindow) || input.baselineSendsPerWindow < 0) {
      throw new RangeError(
        `baselineSendsPerWindow must be a non-negative finite number or null, got ` +
          String(input.baselineSendsPerWindow),
      );
    }
  }

  const threshold = breakerThreshold(input.baselineSendsPerWindow, params.breaker);
  const reading = (state: BreakerState): BreakerReading => ({
    state,
    threshold,
    baseline: input.baselineSendsPerWindow,
    ratio: params.breaker.ratio,
    floor: params.breaker.floorSendsPerWindow,
  });
  const armed: BreakerState = threshold === null ? 'unarmed' : 'armed';

  // Order is the design. The kill switch outranks everything because it is the one halt a
  // human asked for; the latch outranks the live rate because a breaker that re-evaluates
  // a rate that has since fallen would close itself, which is what "release is manual"
  // forbids.
  if (input.control.killSwitch) {
    return {
      state: 'halted',
      reason: 'kill_switch',
      pages: false,
      detail: 'kill switch engaged; the outbox keeps accumulating decisions',
      breaker: reading(input.control.breakerLatched ? 'latched' : armed),
    };
  }
  if (input.control.breakerLatched) {
    return {
      state: 'halted',
      reason: 'breaker_latched',
      pages: false,
      detail: 'anomaly breaker tripped earlier and has not been closed by a human',
      breaker: reading('latched'),
    };
  }
  if (input.sendsInWindow === null) {
    return {
      state: 'halted',
      reason: 'unknown_send_rate',
      pages: true,
      detail: 'send rate for the budget window is unavailable, so G cannot be enforced',
      breaker: reading(armed),
    };
  }
  if (input.sendsInWindow >= params.globalWindowSends) {
    return {
      state: 'halted',
      reason: 'global_budget_exhausted',
      pages: true,
      detail:
        `${String(input.sendsInWindow)} sends in the last ` +
        `${String(Math.round(params.globalWindowMs / 1000))}s; budget G is ` +
        String(params.globalWindowSends),
      breaker: reading(armed),
    };
  }
  if (threshold !== null && input.sendsInWindow > threshold) {
    return {
      state: 'halted',
      reason: 'send_rate_anomaly',
      pages: true,
      detail:
        `${String(input.sendsInWindow)} sends in the window exceeds the breaker threshold ` +
        `${String(threshold)}; close it by hand after inspection`,
      breaker: reading('tripped'),
    };
  }

  const budgetHeadroom = params.globalWindowSends - input.sendsInWindow;
  const breakerHeadroom =
    threshold === null ? Number.POSITIVE_INFINITY : Math.floor(threshold) - input.sendsInWindow;
  return {
    state: 'open',
    claimLimit: Math.max(0, Math.min(input.batchSize, budgetHeadroom, breakerHeadroom)),
    breaker: reading(armed),
  };
}

function assertCount(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer >= ${String(minimum)}, got ${String(value)}`);
  }
}
