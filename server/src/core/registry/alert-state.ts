/**
 * `migrateAlertState` — what a merge does to who has already been told (ADR-002 D3 and
 * invariant I3, ADR-004 D3).
 *
 * The failure this exists to prevent is specific and expensive. A zone is notified about
 * fire A. An hour later a detection bridges A and B, B wins the survivor rule, and A's
 * alert state stays behind on A's row. The next evaluation looks at B, finds no alert state
 * for this zone, and sends "new fire" — about a fire the user was told about an hour ago,
 * under an id the API now redirects away from. Twice-notified is not a cosmetic bug in a
 * product whose entire value is that a message from it means something; it is the fastest
 * way to teach people to mute us.
 *
 * So the rule is: the survivor inherits the **most advanced** state of **every** parent,
 * per zone, and the parents' rows are moved rather than copied — a state left on a
 * tombstone is a second mouth. This runs inside the same transaction as the tombstone
 * writes and the re-attribution; a merge that committed the identity change and left the
 * alert migration for a second transaction would have a window in which exactly the double
 * notification above is not just possible but likely, because the merge is what wakes the
 * evaluator.
 *
 * Not here: the reignition leg. ADR-004 A1.6 gives `migrateAlertState` a second caller —
 * an event revived after a quiet spell — with its own rule about whether the old state
 * carries over or the cooldown restarts. That is D3's decision and D3's data (the relation
 * kind, the fuel-band window); {@link foldAlertStates} is written to be the shared half
 * when it lands, which is why it takes rows and a target rather than a merge.
 */

import { epochMsFromIso } from '../ports/clock.js';

/**
 * The ladder from ADR-004 D3. Order is load-bearing: it is read as a rank below, and the
 * fold takes the maximum.
 */
export const ALERT_STATES = ['none', 'notified_new', 'notified_escalation', 'cooldown'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

/** One row of `alert_states`, keyed by `(zone, event)` as the table is. */
export interface AlertStateRow {
  readonly zoneId: string;
  readonly eventPublicId: string;
  readonly state: AlertState;
  /**
   * The escalation step already sent (A1.11). Monotone by contract — an escalation that
   * un-escalates would re-send a message the user already has.
   */
  readonly escalationWatermark: number;
  readonly seededAtIso: string | null;
  readonly lastNotifiedAtIso: string | null;
}

/** The `(zone, event)` pair, for the rows a migration removes. */
export interface AlertStateKey {
  readonly zoneId: string;
  readonly eventPublicId: string;
}

/**
 * Position on the ladder. "Most advanced" and "most suppressive" coincide across all four
 * states — `cooldown` is both furthest along and the quietest — which is why one maximum
 * serves both purposes. A fifth state that broke that coincidence would need the fold
 * re-derived rather than the ladder reordered; the test pins the coincidence so the
 * question cannot be answered by accident.
 */
export function alertStateRank(state: AlertState): number {
  const rank = ALERT_STATES.indexOf(state);
  if (rank < 0) throw new RangeError(`unknown alert state ${JSON.stringify(state)}`);
  return rank;
}

/** I3's predicate: has this zone already been told about this fire? */
export function isNotified(state: AlertState): boolean {
  return state !== 'none';
}

/**
 * Folds every parent's rows onto one target event, one row per zone.
 *
 * Field by field, and each choice is the conservative one — the one that sends fewer
 * messages, because the cost of a suppressed alert about a fire the user already knows of
 * is far below the cost of a duplicate:
 *
 *   - `state`: the maximum rank. This is what makes I3 provable rather than tested — if any
 *     parent had a state other than `none` for a zone, the maximum is also not `none`, so
 *     "new fire" cannot fire again for that zone.
 *   - `escalationWatermark`: the maximum, so no escalation step is re-sent (A1.11).
 *   - `lastNotifiedAt`: the latest, so the ~6 h suppression window is measured from the
 *     most recent message the user actually received.
 *   - `seededAt`: the earliest, because it records when this zone first learned of the
 *     fire, and the survivor inherits the fire's history, not its own row's age.
 *
 * Rows for events other than the parents are the caller's mistake to make, not this
 * function's to guess at, and are rejected. Output is ascending by `zoneId`.
 */
export function foldAlertStates(
  rows: readonly AlertStateRow[],
  targetPublicId: string,
  parentPublicIds: readonly string[],
): readonly AlertStateRow[] {
  const parents = new Set([targetPublicId, ...parentPublicIds]);
  const byZone = new Map<string, AlertStateRow>();

  for (const row of rows) {
    if (!parents.has(row.eventPublicId)) {
      throw new RangeError(
        `alert state for ${row.eventPublicId} is not a parent of ${targetPublicId}`,
      );
    }
    const carried = { ...row, eventPublicId: targetPublicId };
    const held = byZone.get(row.zoneId);
    byZone.set(row.zoneId, held === undefined ? carried : combine(held, carried));
  }

  return [...byZone.keys()].sort().map((zoneId) => byZone.get(zoneId) as AlertStateRow);
}

function combine(a: AlertStateRow, b: AlertStateRow): AlertStateRow {
  return {
    zoneId: a.zoneId,
    eventPublicId: a.eventPublicId,
    state: alertStateRank(a.state) >= alertStateRank(b.state) ? a.state : b.state,
    escalationWatermark: Math.max(a.escalationWatermark, b.escalationWatermark),
    seededAtIso: earlier(a.seededAtIso, b.seededAtIso),
    lastNotifiedAtIso: later(a.lastNotifiedAtIso, b.lastNotifiedAtIso),
  };
}

/**
 * Instant comparison goes through the epoch, not through string order. Both would work for
 * one fixed rendering of a timestamp, and the moment two of them differ — an offset, a
 * fractional second from a different driver — string order silently answers a question
 * about text while claiming to answer one about time.
 */
function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return epochMsFromIso(a) <= epochMsFromIso(b) ? a : b;
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return epochMsFromIso(a) >= epochMsFromIso(b) ? a : b;
}
