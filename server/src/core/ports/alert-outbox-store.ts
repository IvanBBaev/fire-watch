/**
 * The transactional outbox, as the core sees it.
 *
 * ADR-004 D1: an alert decision is written **in the same transaction** as the state
 * change that produced it, and nothing sends synchronously. The port therefore offers a
 * write and no send, and the write takes a batch: one poll decides many pairs, and
 * splitting that across transactions is how a crash leaves a zone notified in
 * `alert_states` about a fire whose outbox row was never written.
 *
 * The store does not open the transaction. It cannot: the state write it must be atomic
 * with lives behind a different port (H3), so the only place that can span both is the
 * caller. `PgQueryable` in the adapter is structural precisely so that a transaction
 * handle satisfies it.
 *
 * **Enqueueing is idempotent, by the key and not by a check.** A1.11's
 * `UNIQUE (zone_id, event_id, alert_type, alert_subkey)` is the anti-spam invariant, so
 * a redelivered decision conflicts and does nothing rather than sending a second time.
 * That is also why the result counts what was already there: a re-decided row is not an
 * error, and a caller that treated it as one would turn a harmless retry into an alarm.
 *
 * **One row is one channel, and that is a real limit.** The row carries `channel` and
 * `channel_subscription_id`, but the unique key does not, so an account reachable on
 * both push and email cannot receive one decision on both — the second row would
 * conflict with the first. The schema says one decision, one delivery. Whoever picks
 * that channel is not this port and not the decision function; it is a question H2 owns,
 * and it is written down here rather than resolved silently because the four-column key
 * makes fan-out *unrepresentable*, not merely unimplemented.
 */

import type { AlertLocale } from '../alerts/templates/alert-copy.js';
import type { AlertType, TriggerType } from '../config/alert-gating.js';

/** D6's three delivery mechanics, and the `channel` CHECK of migration 001. */
export const ALERT_CHANNELS = ['push', 'telegram', 'email'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/**
 * The row's own lifecycle, distinct from the per-`(zone, event)` state machine of D3.
 * Both are called "state" in conversation and neither is the other: this one tracks a
 * delivery, that one tracks what a zone has been told.
 *
 * The three terminal-by-expiry values are not decoration. `expired_unapproved` is an
 * over-budget row that nobody approved inside D6's 6 h queue expiry; `ttl_expired` is a
 * row that outlived the 1800 s push TTL; `cancelled_erasure` is A1.9, set either with
 * the deletion transaction or by the gateway's liveness re-check just before a provider
 * call. A1.12 pages on any of them — an approval that arrived too late is an incident.
 */
export const OUTBOX_STATUSES = [
  'pending',
  'awaiting_approval',
  'claimed',
  'sent',
  'failed',
  'cancelled_erasure',
  'expired_unapproved',
  'ttl_expired',
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** A1.4's two ways a release above budget B can be accountable. */
export const APPROVAL_MODES = ['two_person', 'solo_cooloff'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * A row as the decision writes it — the provenance-bearing half. Everything the gateway
 * fills in later (`dispatched_at`, `provider_ack_at`, `last_error`) is absent on purpose:
 * a draft that could carry a dispatch timestamp is a draft someone will eventually
 * populate at decision time, and the latency instrumentation of D9 is measured from the
 * gap between those two columns.
 */
export interface OutboxRowDraft {
  readonly watchZoneId: string;
  /**
   * `fire_events.id` — the internal bigint, rendered as decimal text because that is how
   * `pg` returns `bigint` and round-tripping it through a JS number loses precision at
   * 2^53. The public `fw-YYYY-xxxxx` id is not this and is not stored here.
   */
  readonly fireEventId: string;
  /** What the recipient is told. Third column of the A1.11 key. */
  readonly alertType: AlertType;
  /** Fourth column: `once`, `step-N`, or the digest window start (A1.11). */
  readonly alertSubkey: string;
  /**
   * What *caused* the row (A1.1). Equals {@link alertType} on every automatic row and
   * differs only for `manual`, which is not something a recipient can be told.
   */
  readonly triggerType: TriggerType;
  /**
   * D1's `trigger_ref`, second half: `fire_events.seq` as it read at decision time. The
   * first half is {@link fireEventId}. Decimal text, for the same reason.
   */
  readonly triggerRefSeq: string;
  /** The versioned gating config that fired (D1, D4). */
  readonly ruleVersion: string;
  /** The exact reviewed copy template (D1, D7). */
  readonly templateId: string;
  /**
   * Bound parameters, **never a rendered body** — A1.3's pseudonymization has to be able
   * to drop the zone-derived ones and keep the rest, which it cannot do to prose.
   */
  readonly templateParams: Readonly<Record<string, unknown>>;
  readonly channel: AlertChannel;
  readonly channelSubscriptionId: string | null;
  /**
   * The language the row is rendered in (migration 015). Decided with the row, so the
   * copy a recipient got is a fact of the decision rather than of whatever a lookup said
   * at send time. `bg` until an account or subscription holds a language of its own.
   */
  readonly locale: AlertLocale;
  /** A1.2's stored queue class, `priorityFor(triggerType)`. Lower dispatches first. */
  readonly priority: number;
  /** A1.12's rank in decision order, or `null` when the account was not ranked. */
  readonly budgetSeq: number | null;
  readonly status: OutboxStatus;
  /** A1.1: the human who initiated. `null` on every automatic row. */
  readonly actorId: string | null;
  readonly approverId: string | null;
  readonly approvalMode: ApprovalMode | null;
  /** Epoch milliseconds, or `null`. The adapter renders the timestamp. */
  readonly approvedAt: number | null;
  /** A1.1: released past budget B (D5). */
  readonly budgetOverride: boolean;
  /**
   * Epoch milliseconds. A parameter and never a clock read, so that the same decision
   * replayed twice writes the same row — the column has a `now()` default the runtime
   * deliberately does not use.
   */
  readonly decidedAt: number;
}

export interface EnqueueResult {
  /** Drafts handed in. */
  readonly received: number;
  /** Rows the database did not already hold under the A1.11 key. */
  readonly inserted: number;
  /** Rows that conflicted — a redelivery, and a no-op by design. */
  readonly alreadyDecided: number;
}

export interface AlertOutboxStore {
  /**
   * Write decisions. Idempotent under the A1.11 key; a batch that is entirely a
   * redelivery inserts nothing and is not an error.
   */
  enqueue(rows: readonly OutboxRowDraft[]): Promise<EnqueueResult>;
}
