/**
 * The meta-alert thresholds (TASKS J1, R5-SRE-8; GATES L-8; OPERATIONS §3).
 *
 * One rule per reading. A rule with `pageAbove: null` would be **unarmed**: its monitor
 * still measures and reports every cycle, but it can never page. Since founder decision
 * 2026-10-30 (J1 / R5-SRE-8, `docs/decisions/founder-2026-10-30/thresholds-ops.md`) all
 * eight rules are armed. One number is the corpus's own; the other seven are derived from
 * the corpus or from the loop capacities the code ships, never invented:
 *
 *   * `outbox_queue_oldest_seconds` > **600 s** — GATES L-8 and ADR-004 D6
 *     (`fw_notification_queue_oldest_seconds`), repeated as OPERATIONS §3 and U-7.
 *   * `outbox_pending_rows` > **6,000** — ten minutes of dispatch capacity (100 rows per
 *     10 s tick, `dispatch-wiring.ts`). A queue deeper than that cannot drain inside L-8's
 *     600 s even at full speed, so it pages before the age rule has to.
 *   * `outbox_claimed_rows` > **200** — two dispatch batches. A healthy tick holds at most
 *     one batch in flight; more than two means claims are leaking.
 *   * `outbox_claimed_oldest_seconds` > **600 s** — L-8 again. The reading is measured
 *     from the decision (no `claimed_at` column), so it is an upper bound on the claim age,
 *     and a claimed row older than 600 s has already missed L-8.
 *   * `outbox_awaiting_approval_oldest_seconds` > **1,800 s** — A1.12's "oldest awaiting
 *     row > 30 min", read from `alert_budgets` so the two pages can never disagree.
 *   * `identity_pending_batches` > **24** — one identity cycle's capacity
 *     (`IDENTITY_MAX_BATCHES_PER_CYCLE`); two consecutive readings above it mean the
 *     backlog survived two full cycles.
 *   * `identity_oldest_pending_seconds` > **600 s** — identity feeds alert evaluation, so
 *     its lag spends L-8's budget; ten minutes is the whole of it.
 *   * `canary_round_trip_seconds` > **600 s** — the canary is a synthetic delivery, held
 *     to the same L-8 window as a real one. Until the off-box probe is deployed (review 27
 *     E-8) the reading is `null`, which the evaluator reports as `no_data`, never a page.
 *
 * The capacity-derived numbers restate `app/` constants because `core` may not import
 * `app`; `app/monitor-wiring.test.ts` pins them, so a capacity change has to touch both.
 * The values are provisional until a season of readings exists — see the decision record.
 * {@link UNARMED_REASONS} stays as the guard: a rule disarmed later must say why.
 *
 * Hysteresis. A page fires only after {@link PAGE_AFTER_CONSECUTIVE} consecutive breaching
 * readings and clears only after {@link CLEAR_AFTER_CONSECUTIVE} consecutive clear ones.
 * "Two consecutive" follows the one precedent the corpus has — OPERATIONS §2.2 rule 7,
 * where the external probe pages only after two consecutive failures. The corpus states no
 * clear band, so `clearAtOrBelow` equals `pageAbove`: the anti-flap comes from the streaks,
 * not from an invented band. Both counts were ratified on 2026-10-30.
 */

import { ALERT_BUDGETS } from '../config/alert-budgets.js';

/** Every reading the monitor loop produces, in report order. */
export const META_ALERT_KEYS = [
  'outbox_queue_oldest_seconds',
  'outbox_pending_rows',
  'outbox_claimed_rows',
  'outbox_claimed_oldest_seconds',
  'outbox_awaiting_approval_oldest_seconds',
  'identity_pending_batches',
  'identity_oldest_pending_seconds',
  'canary_round_trip_seconds',
] as const;

export type MetaAlertKey = (typeof META_ALERT_KEYS)[number];

export interface MetaAlertRule {
  /** Pages when the reading is strictly above this. `null` = unarmed: never pages. */
  readonly pageAbove: number | null;
  /** Counts as clear when the reading is at or below this. Ignored while unarmed. */
  readonly clearAtOrBelow: number | null;
  readonly pageAfter: number;
  readonly clearAfter: number;
}

export type MetaAlertRules = Readonly<Record<MetaAlertKey, MetaAlertRule>>;

/** OPERATIONS §2.2 rule 7's "two consecutive failures", borrowed. Ratified 2026-10-30. */
export const PAGE_AFTER_CONSECUTIVE = 2;
/** Symmetric with the page side. Ratified 2026-10-30. */
export const CLEAR_AFTER_CONSECUTIVE = 2;

/** GATES L-8 / ADR-004 D6: `fw_notification_queue_oldest_seconds` pages at 600 s. */
export const OUTBOX_QUEUE_PAGE_SECONDS = 600;

/**
 * The monitor cadence. Not stated anywhere; one minute keeps the worst-case page latency
 * for the armed rule at 600 s + 2 × 60 s, well inside OPERATIONS §3.1's 10-minute
 * escalation window, for two cheap indexed queries a minute.
 */
export const MONITOR_INTERVAL_MS = 60_000;

/** Dispatch capacity (`app/dispatch-wiring.ts`): rows claimed per tick, and the tick. */
export const DISPATCH_ROWS_PER_TICK = 100;
export const DISPATCH_TICK_SECONDS = 10;
/** Identity capacity (`app/identity-wiring.ts` `IDENTITY_MAX_BATCHES_PER_CYCLE`). */
export const IDENTITY_BATCHES_PER_CYCLE = 24;

/** Ten minutes of dispatch at full speed: a deeper queue cannot drain inside L-8. */
export const OUTBOX_PENDING_PAGE_ROWS =
  DISPATCH_ROWS_PER_TICK * (OUTBOX_QUEUE_PAGE_SECONDS / DISPATCH_TICK_SECONDS);
/** Two batches in flight: one is a healthy tick, more than two is a claim leak. */
export const OUTBOX_CLAIMED_PAGE_ROWS = 2 * DISPATCH_ROWS_PER_TICK;
/** A1.12's 30-minute approval deadline, from the one place it is configured. */
export const APPROVAL_PENDING_PAGE_SECONDS = Math.floor(
  ALERT_BUDGETS.values.approvalPendingPageMs / 1000,
);

function armedAt(pageAbove: number): MetaAlertRule {
  return {
    pageAbove,
    clearAtOrBelow: pageAbove,
    pageAfter: PAGE_AFTER_CONSECUTIVE,
    clearAfter: CLEAR_AFTER_CONSECUTIVE,
  };
}

export const META_ALERT_RULES: MetaAlertRules = {
  outbox_queue_oldest_seconds: armedAt(OUTBOX_QUEUE_PAGE_SECONDS),
  outbox_pending_rows: armedAt(OUTBOX_PENDING_PAGE_ROWS),
  outbox_claimed_rows: armedAt(OUTBOX_CLAIMED_PAGE_ROWS),
  outbox_claimed_oldest_seconds: armedAt(OUTBOX_QUEUE_PAGE_SECONDS),
  outbox_awaiting_approval_oldest_seconds: armedAt(APPROVAL_PENDING_PAGE_SECONDS),
  identity_pending_batches: armedAt(IDENTITY_BATCHES_PER_CYCLE),
  identity_oldest_pending_seconds: armedAt(OUTBOX_QUEUE_PAGE_SECONDS),
  canary_round_trip_seconds: armedAt(OUTBOX_QUEUE_PAGE_SECONDS),
};

/**
 * Why each unarmed rule is unarmed — the list of open decisions, in code. A test fails if
 * a rule is unarmed without an entry here, or armed with one. Empty since 2026-10-30.
 */
export const UNARMED_REASONS: Readonly<Partial<Record<MetaAlertKey, string>>> = {};
