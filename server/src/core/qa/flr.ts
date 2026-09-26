/**
 * FLR — Flapping Lifecycle Rate (GLOSSARY §8; 06 §5.1.2).
 *
 * "events with **≥ 3 lifecycle direction reversals within 48 h** ÷ active events. High FLR
 * predicts duplicate alerts and UX distrust." Target: "flag + review (no numeric gate)" —
 * so this function reports a rate and a list of events to look at, and never a pass or a
 * fail. `target` is `null` in the result and stays `null` until a document states one.
 *
 * ## Three readings the definition needs, and the one taken
 *
 * 1. **What a "direction" is.** The machine states are ordered by how much the system
 *    currently believes the fire is burning: `active` > `signal_weakening` >
 *    `no_longer_detected` > `archived` ({@link ACTIVITY_RANK}). A transition's direction is
 *    the sign of the rank change, and a *reversal* is a directed transition whose sign
 *    opposes the previous directed transition's. So `active → signal_weakening → active →
 *    signal_weakening` contains two reversals, not three: three reversals need four
 *    direction changes across five states. 06 §5.1.2 illustrates flapping with a
 *    four-state chain and the word "cooling", which is not in the frozen vocabulary
 *    (`signal_weakening` is); the illustration is read as an illustration, and the
 *    counting rule is taken from the formula's own words.
 * 2. **Curated states.** `officially_contained` and `officially_extinguished` are
 *    statements by an authority (A2.2), not our rule set changing its mind, and they have
 *    no place on an activity scale. A transition touching one is direction-neutral and
 *    **breaks the chain**: the directed transitions on either side of an official
 *    declaration are not paired into a reversal, because that would count a human
 *    statement as our flapping.
 * 3. **"within 48 h".** A sliding window, not a calendar bucket: the event is flagged if
 *    *any* `minReversals` consecutive reversals span at most the window. A calendar bucket
 *    would let an event flap across a midnight and not be seen.
 */

import type { LifecycleState, MACHINE_LIFECYCLE_STATES } from '@fire-watch/contracts';

import type { EpochMs } from '../ports/clock.js';
import { QA_METRICS, type QaMetricsParams } from './qa-metrics-params.js';
import { rateOf, type Rate } from './rate.js';

/**
 * How much the state says the fire is currently burning. Only an ordering is used — the
 * numbers are ranks, never weights — and the curated states are absent by design (see the
 * header, reading 2).
 */
export const ACTIVITY_RANK: Readonly<Record<(typeof MACHINE_LIFECYCLE_STATES)[number], number>> =
  Object.freeze({
    active: 3,
    signal_weakening: 2,
    no_longer_detected: 1,
    archived: 0,
  });

export interface LifecycleTransition {
  readonly publicId: string;
  readonly atMs: EpochMs;
  readonly from: LifecycleState;
  readonly to: LifecycleState;
}

export interface FlrEvent {
  readonly publicId: string;
  /**
   * Was the event `active` at any point in the window? This is FLR's denominator, and it
   * is a fact about the event's history rather than its state at the window's end — an
   * event that flapped all week and archived on Sunday belongs in the week that saw it.
   */
  readonly activeInWindow: boolean;
}

export interface FlrInput {
  readonly windowStartMs: EpochMs;
  readonly windowEndMs: EpochMs;
  readonly events: readonly FlrEvent[];
  /**
   * Every transition of those events in `[windowStartMs − 48 h, windowEndMs]`. The lead-in
   * is required, not optional: a reversal pattern that completes on Monday morning began
   * on Saturday, and a caller that supplies only the window under-reports it.
   */
  readonly transitions: readonly LifecycleTransition[];
}

export interface FlrVerdict {
  readonly publicId: string;
  readonly activeInWindow: boolean;
  readonly reversals: number;
  /** Reversal instants, ascending. The evidence behind `flagged`. */
  readonly reversalAtMs: readonly number[];
  readonly flagged: boolean;
}

export interface FlrReport {
  readonly configVersion: string;
  readonly configDigest: string;
  readonly windowHours: number;
  readonly minReversals: number;
  /** Flagged active events ÷ active events. */
  readonly rate: Rate;
  /** Always `null`: GLOSSARY §8 sets no numeric gate for FLR. */
  readonly target: null;
  readonly flaggedEventIds: readonly string[];
  /**
   * Flagged events that were not active in the window, so they are outside the
   * denominator. Reported because they are still worth a review even when the ratio
   * cannot count them.
   */
  readonly flaggedInactiveEventIds: readonly string[];
  readonly events: readonly FlrVerdict[];
}

export function flr(input: FlrInput, params: QaMetricsParams = QA_METRICS.values): FlrReport {
  const windowMs = params.flr.windowHours * 3_600_000;
  if (!(input.windowEndMs >= input.windowStartMs)) {
    throw new RangeError('FLR window ends before it starts');
  }

  const known = new Map<string, FlrEvent>();
  for (const event of input.events) {
    if (known.has(event.publicId)) {
      throw new RangeError(`duplicate FLR event ${JSON.stringify(event.publicId)}`);
    }
    known.set(event.publicId, event);
  }

  const byEvent = new Map<string, LifecycleTransition[]>();
  for (const transition of input.transitions) {
    if (!known.has(transition.publicId)) {
      throw new RangeError(
        `transition for unknown event ${JSON.stringify(transition.publicId)}; the population and ` +
          'the history must describe the same events or the ratio is over two different sets',
      );
    }
    if (transition.atMs > input.windowEndMs || transition.atMs < input.windowStartMs - windowMs) {
      throw new RangeError(
        `transition of ${JSON.stringify(transition.publicId)} at ${String(transition.atMs)} is ` +
          'outside the window plus its required lead-in',
      );
    }
    const bucket = byEvent.get(transition.publicId);
    if (bucket === undefined) byEvent.set(transition.publicId, [transition]);
    else bucket.push(transition);
  }

  const verdicts = input.events.map((event) =>
    gradeEvent(event, byEvent.get(event.publicId) ?? [], input, windowMs, params),
  );
  const active = verdicts.filter((verdict) => verdict.activeInWindow);
  const flagged = active.filter((verdict) => verdict.flagged);

  return Object.freeze({
    configVersion: QA_METRICS.version,
    configDigest: QA_METRICS.digest,
    windowHours: params.flr.windowHours,
    minReversals: params.flr.minReversals,
    rate: rateOf(flagged.length, active.length),
    target: null,
    flaggedEventIds: Object.freeze(flagged.map((verdict) => verdict.publicId)),
    flaggedInactiveEventIds: Object.freeze(
      verdicts
        .filter((verdict) => verdict.flagged && !verdict.activeInWindow)
        .map((verdict) => verdict.publicId),
    ),
    events: Object.freeze(verdicts),
  });
}

function gradeEvent(
  event: FlrEvent,
  transitions: readonly LifecycleTransition[],
  input: FlrInput,
  windowMs: number,
  params: QaMetricsParams,
): FlrVerdict {
  // Ascending by instant. Ties keep their input order, which the caller owns; two state
  // changes at the same millisecond are one tick's work and their order is its record.
  const ordered = transitions.slice().sort((a, b) => a.atMs - b.atMs);
  const reversalAtMs: number[] = [];
  let previousDirection = 0;

  for (const transition of ordered) {
    const direction = directionOf(transition);
    if (direction === null) {
      // Curated statement: neutral, and it breaks the chain (header, reading 2).
      previousDirection = 0;
      continue;
    }
    if (direction === 0) continue;
    if (previousDirection !== 0 && direction !== previousDirection) {
      reversalAtMs.push(transition.atMs);
    }
    previousDirection = direction;
  }

  return Object.freeze({
    publicId: event.publicId,
    activeInWindow: event.activeInWindow,
    reversals: reversalAtMs.length,
    reversalAtMs: Object.freeze(reversalAtMs),
    flagged: hasBurst(reversalAtMs, input, windowMs, params),
  });
}

/**
 * `null` when either end is a curated state — see the header. `0` for a transition that
 * does not move on the activity scale, which cannot be a reversal of anything.
 */
function directionOf(transition: LifecycleTransition): number | null {
  const from = rankOf(transition.from);
  const to = rankOf(transition.to);
  if (from === null || to === null) return null;
  return Math.sign(to - from);
}

function rankOf(state: LifecycleState): number | null {
  const ranks: Readonly<Record<string, number | undefined>> = ACTIVITY_RANK;
  // `?? null` and not `|| null`: `archived` ranks 0, and 0 is a rank.
  return ranks[state] ?? null;
}

/** Any `minReversals` consecutive reversals inside one sliding window, ending in the window. */
function hasBurst(
  reversalAtMs: readonly number[],
  input: FlrInput,
  windowMs: number,
  params: QaMetricsParams,
): boolean {
  const need = params.flr.minReversals;
  if (need < 1) throw new RangeError('FLR needs at least one reversal to flag anything');
  for (let last = need - 1; last < reversalAtMs.length; last += 1) {
    const end = reversalAtMs[last];
    const start = reversalAtMs[last - (need - 1)];
    if (end === undefined || start === undefined) continue;
    if (end - start > windowMs) continue;
    // The burst must complete inside the reporting window; the lead-in exists to supply
    // its beginning, not to let last month's flapping into this week's number.
    if (end >= input.windowStartMs && end <= input.windowEndMs) return true;
  }
  return false;
}
