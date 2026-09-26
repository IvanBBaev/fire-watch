/**
 * The meta-alert thresholds (TASKS J1; GATES L-8; OPERATIONS §3).
 *
 * One rule per reading. A rule with `pageAbove: null` is **unarmed**: its monitor still
 * measures and reports every cycle, but it can never page. That is the honest state for
 * every number the corpus does not state — a threshold invented here would page an
 * operator at 03:00 on a guess, and a guess nobody ratified is a guess nobody tunes.
 *
 * Exactly one threshold is documented today, and it is the only armed rule:
 *
 *   * `outbox_queue_oldest_seconds` pages above **600 s** — GATES L-8 and ADR-004 D6
 *     (`fw_notification_queue_oldest_seconds`), repeated as OPERATIONS §3's Grafana leg
 *     and as U-7.
 *
 * Every other rule is unarmed and listed in {@link UNARMED_REASONS}, which the tests hold
 * in lockstep with the rules so an unarmed threshold cannot go undocumented.
 *
 * Hysteresis. A page fires only after {@link PAGE_AFTER_CONSECUTIVE} consecutive breaching
 * readings and clears only after {@link CLEAR_AFTER_CONSECUTIVE} consecutive clear ones.
 * "Two consecutive" follows the one precedent the corpus has — OPERATIONS §2.2 rule 7,
 * where the external probe pages only after two consecutive failures. The corpus states no
 * clear band, so `clearAtOrBelow` equals `pageAbove`: the anti-flap comes from the streaks,
 * not from an invented band. Both counts are open founder decisions.
 */

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

/** OPERATIONS §2.2 rule 7's "two consecutive failures", borrowed. Founder decision. */
export const PAGE_AFTER_CONSECUTIVE = 2;
/** Symmetric with the page side. Founder decision. */
export const CLEAR_AFTER_CONSECUTIVE = 2;

/** GATES L-8 / ADR-004 D6: `fw_notification_queue_oldest_seconds` pages at 600 s. */
export const OUTBOX_QUEUE_PAGE_SECONDS = 600;

/**
 * The monitor cadence. Not stated anywhere; one minute keeps the worst-case page latency
 * for the armed rule at 600 s + 2 × 60 s, well inside OPERATIONS §3.1's 10-minute
 * escalation window, for two cheap indexed queries a minute.
 */
export const MONITOR_INTERVAL_MS = 60_000;

const UNARMED: MetaAlertRule = {
  pageAbove: null,
  clearAtOrBelow: null,
  pageAfter: PAGE_AFTER_CONSECUTIVE,
  clearAfter: CLEAR_AFTER_CONSECUTIVE,
};

export const META_ALERT_RULES: MetaAlertRules = {
  outbox_queue_oldest_seconds: {
    pageAbove: OUTBOX_QUEUE_PAGE_SECONDS,
    clearAtOrBelow: OUTBOX_QUEUE_PAGE_SECONDS,
    pageAfter: PAGE_AFTER_CONSECUTIVE,
    clearAfter: CLEAR_AFTER_CONSECUTIVE,
  },
  outbox_pending_rows: UNARMED,
  outbox_claimed_rows: UNARMED,
  outbox_claimed_oldest_seconds: UNARMED,
  outbox_awaiting_approval_oldest_seconds: UNARMED,
  identity_pending_batches: UNARMED,
  identity_oldest_pending_seconds: UNARMED,
  canary_round_trip_seconds: UNARMED,
};

/**
 * Why each unarmed rule is unarmed — the list of open decisions, in code. A test fails if
 * a rule is unarmed without an entry here, or armed with one.
 */
export const UNARMED_REASONS: Readonly<Partial<Record<MetaAlertKey, string>>> = {
  outbox_pending_rows:
    'No depth threshold is stated; L-8 pages on age, and a deep but fresh queue is healthy.',
  outbox_claimed_rows: 'No threshold is stated for the number of in-flight claims.',
  outbox_claimed_oldest_seconds:
    'No claimed-too-long threshold is stated. alert_outbox has no claimed_at column, so ' +
    'this is the age of the oldest claimed row since its decision — an upper bound on ' +
    'the claim age, not the claim age itself.',
  outbox_awaiting_approval_oldest_seconds:
    'Rows awaiting approval wait on a human by design (budget override); whether a stale ' +
    'approval pages, and after how long, is a founder decision.',
  identity_pending_batches: 'No identity-lag threshold is stated in GATES or OPERATIONS.',
  identity_oldest_pending_seconds:
    'No identity-lag threshold is stated; the identity loop has no heartbeat either, by ' +
    'an earlier founder deferral (identity-wiring.ts).',
  canary_round_trip_seconds:
    'The canary has no deployed probe: it needs an operator delivery channel through the ' +
    'gateway, which is a founder decision (OPERATIONS §3 rule 3, a separate operator bot).',
};
