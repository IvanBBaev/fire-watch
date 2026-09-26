/**
 * A1.12's deterministic B cutoff — which of an event's recipients go out now, and which
 * wait for a human.
 *
 * D5 caps automatic notification at B = 500 recipients per event. A1.12 settles the
 * question that cap raises and that nothing else answers: *which* 500.
 *
 *   > Recipients are ranked in **decision order** - `(priority, decided_at, id)`, the
 *   > dispatcher's own claim order - and the rank is stored on the row as `budget_seq`,
 *   > computed once inside the decision transaction. Ranks <= 500 release automatically;
 *   > the rest go to `awaiting_approval` (A1.4). The cut is therefore reproducible from
 *   > the rows alone in replay and audit. No randomization, and deliberately **not**
 *   > distance ordering (a distance-ordered cut is not stable across geometry revisions).
 *
 * Three consequences shape this module:
 *
 *   - **The rank is data, not a query.** Storing `budget_seq` means an auditor asking "why
 *     was this person not told" reads one integer off the row, and a replay of that
 *     afternoon reproduces the same integer without knowing anything about who else was
 *     subscribed at the time. A cut recomputed at dispatch time would move whenever the
 *     recipient set moved.
 *   - **One rank per row, ever.** "Computed once inside the decision transaction" is why
 *     {@link applyBudgetCutoff} takes only rows that have no rank yet, and why an event
 *     that decides in several transactions passes {@link CutoffOptions.previouslyRanked}
 *     to continue the sequence. D5's B is a per-*event* ceiling: a fire that grows all
 *     afternoon would otherwise collect a fresh 500 automatic sends every time a new
 *     detection landed, and the ceiling would mean nothing on exactly the fires it was
 *     written for.
 *   - **The tie-break carries the whole cut.** All of an event's rows are written by one
 *     decision, so they share a `priority` (A1.2 assigns it per trigger type) and a
 *     `decided_at` (one decision instant, passed in, never a clock read). The first two
 *     ordering terms are therefore constant across the batch and the identity term
 *     decides who is inside 500 and who waits.
 *
 * **Where the identity comes from, and the one hazard in it.** A1.12 names `id`, which
 * `alert_outbox` assigns on insert - so at the moment the ranks are computed the rows may
 * not have one yet. Both readings are implementable inside a single transaction, and the
 * adapter picks: either insert first and rank with a window function over
 * `(priority, decided_at, id)`, or rank drafts here and insert **in the returned order**,
 * which makes the assigned ids ascend in the same order and the two readings agree. What
 * an adapter must not do is rank on one key and insert in another order, because then the
 * stored `budget_seq` and the queue's `ORDER BY priority, decided_at, id` disagree about
 * the same batch - and `budget_seq` exists precisely so that they cannot.
 *
 * The identity comparison is a hazard for a second, duller reason: `alert_outbox.id` is a
 * `bigint` carried as decimal text, and `'10' < '9'` lexicographically. A string sort would
 * put row 10 ahead of row 9 while Postgres puts 9 first - a disagreement that appears only
 * once an event crosses a digit boundary, i.e. on the tenth recipient, and then silently
 * moves the cut. {@link compareIdentity} therefore compares all-digit keys numerically and
 * everything else (uuid zone ids) lexicographically, and refuses to compare one against
 * the other rather than guess which ordering the caller meant.
 *
 * No clock, no randomness, no distance: the same rows in the same order produce the same
 * cut on any machine, in any season, in a replay.
 */

import { ALERT_BUDGETS, clampToShipped, type AlertBudgetParams } from '../config/alert-budgets.js';
import type { OutboxStatus } from '../ports/alert-outbox-store.js';

/** The two statuses a freshly decided row may be written with (D1's set, A1.12's cut). */
export type CutoffStatus = Extract<OutboxStatus, 'pending' | 'awaiting_approval'>;

export interface BudgetCandidate {
  /**
   * The row's stable identity - `alert_outbox.id` as decimal text once it exists, or the
   * `watch_zone_id` of the draft that will become it (see the module header on which is
   * legitimate when). All candidates in one call must be the same kind of key.
   */
  readonly identity: string;
  /** A1.2's queue priority, from `priorityFor(trigger_type)`. */
  readonly priority: number;
  /** Epoch ms of the decision. A parameter, never a clock read. */
  readonly decidedAt: number;
}

export interface RankedCandidate {
  readonly identity: string;
  /** `alert_outbox.budget_seq`, one-based and dense across the event. */
  readonly budgetSeq: number;
  /** `pending` while `budgetSeq <= B`, `awaiting_approval` after it. */
  readonly status: CutoffStatus;
}

export interface BudgetCutoff {
  /** Every candidate, in decision order, each with its rank and status. */
  readonly ranked: readonly RankedCandidate[];
  /** How many of this call's candidates release automatically. */
  readonly released: number;
  /** How many wait for T-approve (A1.4). */
  readonly deferred: number;
  /**
   * The rank the event's next decision transaction continues from - i.e. what to pass
   * back as {@link CutoffOptions.previouslyRanked}.
   */
  readonly nextSeq: number;
  /** The B actually enforced, after {@link clampToShipped}. Worth logging next to a cut. */
  readonly budget: number;
}

export interface CutoffOptions {
  /**
   * How many rows this event has already ranked in earlier decision transactions. Zero
   * for a first decision; for a growing fire, the previous call's {@link BudgetCutoff.nextSeq}.
   */
  readonly previouslyRanked?: number;
  readonly params?: AlertBudgetParams;
}

/**
 * Rank one event's newly decided rows and cut them at B.
 *
 * Pure and total: it throws on inputs that would make the cut ambiguous (a duplicate
 * identity, a non-finite `decidedAt`, keys of two different kinds) rather than picking an
 * order, because an ambiguous cut is one that a replay cannot reproduce - and reproducing
 * it is the entire reason A1.12 stores the rank.
 */
export function applyBudgetCutoff(
  candidates: readonly BudgetCandidate[],
  options: CutoffOptions = {},
): BudgetCutoff {
  const params = clampToShipped(options.params ?? ALERT_BUDGETS.values);
  const previouslyRanked = options.previouslyRanked ?? 0;
  if (!Number.isInteger(previouslyRanked) || previouslyRanked < 0) {
    throw new RangeError(
      `previouslyRanked must be a non-negative integer, got ${String(previouslyRanked)}`,
    );
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.priority)) {
      throw new RangeError(
        `candidate ${candidate.identity} has priority ${String(candidate.priority)}, which is ` +
          'not an integer; priorities come from priorityFor(trigger_type)',
      );
    }
    if (!Number.isFinite(candidate.decidedAt)) {
      throw new RangeError(
        `candidate ${candidate.identity} has decidedAt ${String(candidate.decidedAt)}, which is ` +
          'not a finite epoch',
      );
    }
    if (seen.has(candidate.identity)) {
      // Two rows claiming one identity have no order between them, so the cut would depend
      // on argument order - the one thing a stored rank must never depend on.
      throw new TypeError(`duplicate candidate identity ${candidate.identity}`);
    }
    seen.add(candidate.identity);
  }

  const ordered = [...candidates].sort(compareDecisionOrder);
  const ranked = ordered.map((candidate, index): RankedCandidate => {
    const budgetSeq = previouslyRanked + index + 1;
    return {
      identity: candidate.identity,
      budgetSeq,
      status: budgetSeq <= params.perEventAutoSends ? 'pending' : 'awaiting_approval',
    };
  });

  const released = ranked.filter((row) => row.status === 'pending').length;
  return {
    ranked,
    released,
    deferred: ranked.length - released,
    nextSeq: previouslyRanked + ranked.length,
    budget: params.perEventAutoSends,
  };
}

/**
 * A1.12's `(priority, decided_at, id)`, as a comparator - the same order
 * `alert_outbox_dispatch_queue` indexes and the gateway claims in.
 */
export function compareDecisionOrder(a: BudgetCandidate, b: BudgetCandidate): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  if (a.decidedAt !== b.decidedAt) {
    return a.decidedAt - b.decidedAt;
  }
  return compareIdentity(a.identity, b.identity);
}

const DECIMAL_KEY = /^[0-9]+$/;

/**
 * Compare two row identities the way Postgres would compare the columns they stand for:
 * `bigint` ids numerically, uuid zone ids lexicographically.
 *
 * Mixing the two kinds in one batch throws. It cannot happen in a legitimate call - a
 * decision transaction holds either drafts or inserted rows, never both - and if it does
 * happen there is no ordering that is right, only two that are wrong in different places.
 */
export function compareIdentity(a: string, b: string): number {
  const aDecimal = DECIMAL_KEY.test(a);
  const bDecimal = DECIMAL_KEY.test(b);
  if (aDecimal !== bDecimal) {
    throw new TypeError(
      `cannot order identity ${a} against ${b}: one is a decimal row id and the other is not`,
    );
  }
  if (aDecimal) {
    // Digit count first, then lexicographic within a count: that is numeric order for
    // arbitrarily long decimals, without turning a bigint into a float on the way.
    const left = stripLeadingZeros(a);
    const right = stripLeadingZeros(b);
    if (left.length !== right.length) {
      return left.length - right.length;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function stripLeadingZeros(value: string): string {
  const trimmed = value.replace(/^0+/, '');
  return trimmed === '' ? '0' : trimmed;
}
