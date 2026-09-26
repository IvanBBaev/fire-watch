/**
 * The read side of the outbox over Postgres — ADR-004 D1/D2, A1.2.
 *
 * **Claiming is one statement.** `SELECT … FOR UPDATE SKIP LOCKED` picks the next rows in
 * A1.2's stored order and the `UPDATE` in the same statement moves them `pending` →
 * `claimed`, so there is no instant at which a row has been read and not yet owned. That
 * is the port's rule ("claiming is a state transition, not a read") made physical, and it
 * is what keeps a second worker — which D1 does not plan for, but a botched deploy can
 * start — from sending the same row twice. `SKIP LOCKED` makes the second worker take the
 * *next* rows rather than queue behind the first.
 *
 * **Every settle is conditional on `status = 'claimed'`.** A row can leave `claimed`
 * behind the gateway's back — A1.9's deletion transaction sets `cancelled_erasure` on
 * whatever is still queued — and a settle that overwrote that with `sent` would erase the
 * evidence that the send had been stopped. A settle that matches nothing therefore throws;
 * the gateway counts the row `errored` and the erasure stands.
 *
 * ## The claim lease (migration 015)
 *
 * The claim stamps `claimed_at` with the dispatcher's `now`, and the claim is owned for
 * `CLAIM_LEASE_MS` from there (`core/alerts/claim-lease.ts`). Three statements keep that
 * ownership honest:
 *
 *   * **Settles are fenced on the claim.** This adapter remembers, per id it claimed and
 *     has not settled, the `claimed_at` it claimed with, and every settle matches
 *     `status = 'claimed' AND claimed_at = <that instant>`. A row whose lease expired and
 *     which another dispatcher has claimed since carries a different `claimed_at`, so the
 *     stale dispatcher's settle matches nothing and throws instead of overwriting the
 *     new owner's outcome. Settling an id this instance never claimed throws too.
 *   * **Within a process**, {@link PgAlertDispatchQueue.releaseAbandonedClaims} returns
 *     this instance's unsettled claims to `pending` (fenced the same way), so a row the
 *     previous cycle abandoned because a port threw is retried one interval later.
 *   * **Across processes**, {@link PgAlertDispatchQueue.releaseExpiredClaims} returns every
 *     claim older than the lease to `pending`. It replaces the start-up step that released
 *     *every* claimed row — safe only under D1's single dispatcher, and a double send
 *     waiting to happen under an overlapping deploy. A crashed dispatcher's rows now come
 *     back one lease after their claim, whoever runs the next cycle; the gateway's
 *     `leaseAllowsSend` check means a live dispatcher's rows are never in a provider call
 *     when that happens.
 *
 * A provider call that returned and a settle that then failed is the one case where
 * either release re-sends: at-least-once is D1's stated delivery guarantee, and the A1.11
 * key makes the duplicate a duplicate *delivery* of one decision, never a second decision.
 */

import { ALERT_LOCALES } from '../../core/alerts/templates/alert-copy.js';
import { ALERT_TYPES, TRIGGER_TYPES } from '../../core/config/alert-gating.js';
import type {
  AlertDispatchQueue,
  ClaimedOutboxRow,
  SettleOutcome,
} from '../../core/ports/alert-dispatch-queue.js';
import {
  ALERT_CHANNELS,
  APPROVAL_MODES,
  OUTBOX_STATUSES,
  type OutboxStatus,
} from '../../core/ports/alert-outbox-store.js';
import type { SendRateReader } from '../../core/ports/send-rate-reader.js';
import { boolean, epochMs, field, number, string } from './pg-rows.js';

/**
 * The slice of `pg` this module uses — rows as well as counts, because a claim reads what
 * it took. Redeclared rather than imported, like every other adapter's.
 */
export interface PgDispatchQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/**
 * The statuses a `closed` settle may write. `pending`, `awaiting_approval` and `claimed`
 * are not closes, and `sent` has its own outcome with its own timestamps.
 */
const TERMINAL_CLOSES: readonly OutboxStatus[] = [
  'failed',
  'cancelled_erasure',
  'expired_unapproved',
  'ttl_expired',
];

/**
 * `bigint` columns leave as text, because `pg` returns them as decimal strings anyway and
 * the port's ids are decimal text. The final `ORDER BY` qualifies its columns with the CTE
 * name on purpose: unqualified, `id` would bind to the *output* column — the text cast —
 * and order `'10'` before `'9'`.
 */
const CLAIM = `
WITH next AS (
  SELECT id
  FROM alert_outbox
  WHERE status = 'pending' AND decided_at <= $2::timestamptz
  ORDER BY priority, decided_at, id
  LIMIT $1
  FOR UPDATE SKIP LOCKED
), claimed AS (
  UPDATE alert_outbox o
  SET status = 'claimed', claimed_at = $2::timestamptz
  FROM next
  WHERE o.id = next.id
  RETURNING o.*
)
SELECT
  claimed.id::text AS id,
  claimed.watch_zone_id::text AS watch_zone_id,
  claimed.fire_event_id::text AS fire_event_id,
  claimed.alert_type,
  claimed.alert_subkey,
  claimed.trigger_type,
  claimed.trigger_ref_seq::text AS trigger_ref_seq,
  claimed.rule_version,
  claimed.template_id,
  claimed.template_params,
  claimed.channel,
  claimed.channel_subscription_id::text AS channel_subscription_id,
  claimed.locale,
  claimed.priority,
  claimed.budget_seq,
  claimed.status,
  claimed.actor_id,
  claimed.approver_id,
  claimed.approval_mode,
  claimed.approved_at,
  claimed.budget_override,
  claimed.decided_at,
  claimed.claimed_at
FROM claimed
ORDER BY claimed.priority, claimed.decided_at, claimed.id`;

/**
 * Every settle is fenced on the claim — the row is still `claimed`, and by the claim this
 * instance made (`claimed_at`). The fence is the last positional parameter of each.
 */
const SETTLE_SENT = `
UPDATE alert_outbox
SET status = 'sent', dispatched_at = $2::timestamptz, provider_ack_at = $3::timestamptz
WHERE id = $1::bigint AND status = 'claimed' AND claimed_at = $4::timestamptz`;

const SETTLE_CLOSED = `
UPDATE alert_outbox
SET status = $2, last_error = $3, dispatched_at = $4::timestamptz
WHERE id = $1::bigint AND status = 'claimed' AND claimed_at = $5::timestamptz`;

const SETTLE_RELEASED = `
UPDATE alert_outbox
SET status = 'pending', last_error = $2
WHERE id = $1::bigint AND status = 'claimed' AND claimed_at = $3::timestamptz`;

const RELEASE_ABANDONED = `
UPDATE alert_outbox AS o
SET status = 'pending', last_error = $3
FROM unnest($1::bigint[], $2::timestamptz[]) AS mine(id, claimed_at)
WHERE o.id = mine.id AND o.status = 'claimed' AND o.claimed_at = mine.claimed_at`;

/** Served by the partial index `alert_outbox_claim_lease` (migration 015). */
const RELEASE_EXPIRED = `
UPDATE alert_outbox
SET status = 'pending', last_error = $2
WHERE status = 'claimed' AND claimed_at <= $1::timestamptz`;

/**
 * Every provider hand-off stamps `dispatched_at` — a delivery, and a permanent failure
 * that reached the provider. Both count against G: the budget limits what we *attempt* to
 * put on people's phones, and a storm of rejected sends is still a storm. A transient
 * failure is settled `released` and records no `dispatched_at`, so it is not counted; the
 * retry that succeeds is.
 */
const SENDS_SINCE = `
SELECT count(*)::integer AS sends
FROM alert_outbox
WHERE dispatched_at >= $1::timestamptz`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const ALERT_DISPATCH_SQL = {
  claim: CLAIM,
  settleSent: SETTLE_SENT,
  settleClosed: SETTLE_CLOSED,
  settleReleased: SETTLE_RELEASED,
  releaseAbandoned: RELEASE_ABANDONED,
  releaseExpired: RELEASE_EXPIRED,
  sendsSince: SENDS_SINCE,
} as const;

export const ABANDONED_CLAIM_ERROR = 'claim abandoned mid-row; released for retry';
export const EXPIRED_CLAIM_ERROR = 'claim lease expired; released for retry';

export interface PgAlertDispatchQueue extends AlertDispatchQueue {
  /**
   * Return to `pending` every row this instance claimed and has not settled. Called
   * between cycles, when no row can legitimately be in flight. Resolves with the count.
   */
  releaseAbandonedClaims(): Promise<number>;
  /**
   * Return to `pending` every claim made at or before `cutoff` (epoch ms) — any
   * dispatcher's, this one's included. The caller derives the cutoff from the lease
   * (`leaseExpiryCutoff`). Resolves with the count.
   */
  releaseExpiredClaims(cutoff: number): Promise<number>;
}

export function createPgAlertDispatchQueue(db: PgDispatchQueryable): PgAlertDispatchQueue {
  /** id → the `claimed_at` this instance claimed it with, as the ISO text it bound. */
  const unsettled = new Map<string, string>();

  return {
    async claim(limit: number, now: number): Promise<readonly ClaimedOutboxRow[]> {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(`claim limit must be a positive integer, got ${String(limit)}`);
      }
      const claimedAt = isoTimestamp(now, 'now');
      const result = await db.query(CLAIM, [limit, claimedAt]);
      // Remembered before decoding: a row that fails to decode is still claimed in the
      // table, and forgetting it here would strand it until its lease expires.
      const ids = result.rows.map((row) => string(field(row, 'id'), 'id'));
      for (const id of ids) unsettled.set(id, claimedAt);
      return result.rows.map(decodeClaimedRow);
    },

    async settle(id: string, outcome: SettleOutcome): Promise<void> {
      const idText = bigintText(id);
      const claimedAt = unsettled.get(idText);
      if (claimedAt === undefined) {
        throw new Error(`outbox row ${idText} is not claimed by this dispatcher; not settled`);
      }
      let result: { rowCount: number | null };
      if (outcome.kind === 'sent') {
        result = await db.query(SETTLE_SENT, [
          idText,
          isoTimestamp(outcome.dispatchedAt, 'dispatched_at'),
          isoTimestamp(outcome.providerAckAt, 'provider_ack_at'),
          claimedAt,
        ]);
      } else if (outcome.kind === 'closed') {
        if (!TERMINAL_CLOSES.includes(outcome.status)) {
          throw new TypeError(`cannot close outbox row ${idText} as ${outcome.status}`);
        }
        result = await db.query(SETTLE_CLOSED, [
          idText,
          outcome.status,
          outcome.error,
          outcome.dispatchedAt === null
            ? null
            : isoTimestamp(outcome.dispatchedAt, 'dispatched_at'),
          claimedAt,
        ]);
      } else {
        result = await db.query(SETTLE_RELEASED, [idText, outcome.error, claimedAt]);
      }
      // Forgotten whatever the count says: a row that is no longer claimed by this claim
      // is not this instance's to release, and releasing it later would undo whoever
      // moved it.
      unsettled.delete(idText);
      if (result.rowCount !== 1) {
        throw new Error(
          `outbox row ${idText} was no longer held by this claim when it was settled ` +
            `${outcome.kind}; another writer moved it first (erasure, or lease expiry)`,
        );
      }
    },

    async releaseAbandonedClaims(): Promise<number> {
      if (unsettled.size === 0) return 0;
      const entries = [...unsettled];
      const result = await db.query(RELEASE_ABANDONED, [
        entries.map(([id]) => id),
        entries.map(([, claimedAt]) => claimedAt),
        ABANDONED_CLAIM_ERROR,
      ]);
      // Cleared only after the statement succeeded, so a failed release is retried whole.
      for (const [id] of entries) unsettled.delete(id);
      return result.rowCount ?? 0;
    },

    async releaseExpiredClaims(cutoff: number): Promise<number> {
      const result = await db.query(RELEASE_EXPIRED, [
        isoTimestamp(cutoff, 'cutoff'),
        EXPIRED_CLAIM_ERROR,
      ]);
      return result.rowCount ?? 0;
    },
  };
}

export function createPgSendRateReader(db: PgDispatchQueryable): SendRateReader {
  return {
    async sendsSince(from: number): Promise<number> {
      const result = await db.query(SENDS_SINCE, [isoTimestamp(from, 'from')]);
      const [row] = result.rows;
      if (row === undefined) throw new Error('send count returned no row');
      const sends = number(field(row, 'sends'), 'sends');
      if (!Number.isSafeInteger(sends) || sends < 0) {
        throw new Error('sends is not a non-negative integer');
      }
      return sends;
    },
  };
}

/**
 * One claimed row, every column checked. The enums are validated against the same
 * constants the CHECK constraints were written from: a value outside them means the
 * schema and the code have drifted, and dispatching a row whose `trigger_type` the
 * accountability rule has never heard of is how A1.1 would be bypassed.
 */
export function decodeClaimedRow(row: unknown): ClaimedOutboxRow {
  return {
    id: string(field(row, 'id'), 'id'),
    watchZoneId: string(field(row, 'watch_zone_id'), 'watch_zone_id'),
    fireEventId: string(field(row, 'fire_event_id'), 'fire_event_id'),
    alertType: oneOf(field(row, 'alert_type'), ALERT_TYPES, 'alert_type'),
    alertSubkey: string(field(row, 'alert_subkey'), 'alert_subkey'),
    triggerType: oneOf(field(row, 'trigger_type'), TRIGGER_TYPES, 'trigger_type'),
    triggerRefSeq: string(field(row, 'trigger_ref_seq'), 'trigger_ref_seq'),
    ruleVersion: string(field(row, 'rule_version'), 'rule_version'),
    templateId: string(field(row, 'template_id'), 'template_id'),
    templateParams: templateParams(field(row, 'template_params')),
    channel: oneOf(field(row, 'channel'), ALERT_CHANNELS, 'channel'),
    channelSubscriptionId: nullable(
      field(row, 'channel_subscription_id'),
      string,
      'channel_subscription_id',
    ),
    locale: oneOf(field(row, 'locale'), ALERT_LOCALES, 'locale'),
    priority: integer(field(row, 'priority'), 'priority'),
    budgetSeq: nullable(field(row, 'budget_seq'), integer, 'budget_seq'),
    status: oneOf(field(row, 'status'), OUTBOX_STATUSES, 'status'),
    actorId: nullable(field(row, 'actor_id'), string, 'actor_id'),
    approverId: nullable(field(row, 'approver_id'), string, 'approver_id'),
    approvalMode: nullable(
      field(row, 'approval_mode'),
      (value, name) => oneOf(value, APPROVAL_MODES, name),
      'approval_mode',
    ),
    approvedAt: nullable(field(row, 'approved_at'), epochMs, 'approved_at'),
    budgetOverride: boolean(field(row, 'budget_override'), 'budget_override'),
    decidedAt: epochMs(field(row, 'decided_at'), 'decided_at'),
    claimedAt: epochMs(field(row, 'claimed_at'), 'claimed_at'),
  };
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string,
): T[number] {
  const text = string(value, name);
  const member = allowed.find((entry) => entry === text);
  if (member === undefined) throw new Error(`${name} holds a value outside its vocabulary`);
  return member;
}

function nullable<T>(
  value: unknown,
  decode: (value: unknown, name: string) => T,
  name: string,
): T | null {
  return value === null ? null : decode(value, name);
}

function integer(value: unknown, name: string): number {
  const parsed = number(value, name);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is not an integer`);
  return parsed;
}

/** `jsonb` arrives parsed. Only an object is a parameter bag; an array or scalar is not. */
function templateParams(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('template_params is not a JSON object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function bigintText(id: string): string {
  if (!/^\d+$/.test(id)) throw new RangeError('outbox id is not a decimal bigint');
  return id;
}

function isoTimestamp(epochMs: number, name: string): string {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`${name} must be a finite epoch, got ${String(epochMs)}`);
  }
  return new Date(epochMs).toISOString();
}
