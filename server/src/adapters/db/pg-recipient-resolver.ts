/**
 * A1.9's liveness re-check and the endpoint read, over Postgres — one statement, as the
 * port requires ("a liveness check and an endpoint read that could disagree would put the
 * send on the wrong side of the race the rule was written for").
 *
 * **Live means all of it.** The zone exists and is not soft-deleted, its account exists and
 * is not soft-deleted, the row names a subscription, and that subscription exists, is not
 * revoked, is confirmed (double opt-in, migration 012), has an endpoint and belongs to the
 * zone's account. Every other combination is a `live: false` with a reason, and the reason names *which* link broke — it ends up in
 * `last_error`, and "cancelled because the account was deleted" and "cancelled because the
 * browser dropped the subscription" are different post-mortems.
 *
 * A subscription that belongs to a different account than the zone is not a dead
 * recipient, it is a row that would deliver one person's fire to another person's phone.
 * That throws: the gateway counts the row `errored` rather than closing it quietly, because
 * the decision side wrote something it must never write.
 *
 * **Confirmation is part of liveness** (TASKS I3; ADR-004 D6; 05 §5.5.3). A subscription
 * whose `confirmed_at` is null never resolves live, whatever else is true of it: this is
 * the one place every send passes, so it is where "no alert leaves before the double
 * opt-in" is enforced rather than hoped for. It is checked after revocation, so a
 * subscription that was revoked before it was ever confirmed says "revoked".
 *
 * **The subscription's channel is returned, not judged.** A live recipient carries the
 * channel its subscription is on, and `dispatchVerdict` closes a row whose channel differs
 * (`channel_mismatch`, TASKS H5): a `push` row pointing at a `telegram` subscription would
 * hand a push payload to the Telegram adapter with a chat id as its endpoint. The check is
 * in the core rather than here so that it is unit-tested with every other close reason
 * and so that this adapter stays a reader.
 *
 * **Locale is not resolved here.** It is decided with the row and stored on it (migration
 * 015), so the language a row is sent in is a fact of the decision.
 *
 * `reprompt` and `prune` both stop using the endpoint, which is all the table can record;
 * the "please re-subscribe" prompt a `reprompt` asks for needs a flag the schema lacks.
 */

import type { SubscriptionDisposition } from '../../core/ports/alert-channel.js';
import { ALERT_CHANNELS, type AlertChannel } from '../../core/ports/alert-outbox-store.js';
import type { RecipientResolver, ResolvedRecipient } from '../../core/ports/recipient-resolver.js';
import { field, string } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgRecipientQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/**
 * `LEFT JOIN` on the subscription so a missing one is an answer ("gone") rather than no
 * row at all, which would be indistinguishable from a missing zone.
 */
const RESOLVE = `
SELECT
  z.deleted_at AS zone_deleted_at,
  a.id::text AS account_id,
  a.deleted_at AS account_deleted_at,
  a.timezone,
  s.id::text AS subscription_id,
  s.account_id::text AS subscription_account_id,
  s.channel,
  s.endpoint,
  s.revoked_at,
  s.confirmed_at
FROM watch_zones z
JOIN accounts a ON a.id = z.account_id
LEFT JOIN channel_subscriptions s ON s.id = $2::uuid
WHERE z.id = $1::uuid`;

/**
 * Conditional on `revoked_at IS NULL` so a second prune keeps the first instant — the
 * one that says when we stopped writing to that endpoint.
 */
const REVOKE = `
UPDATE channel_subscriptions
SET revoked_at = $2::timestamptz
WHERE id = $1::uuid AND revoked_at IS NULL`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const RECIPIENT_SQL = { resolve: RESOLVE, revoke: REVOKE } as const;

export interface PgRecipientResolverOptions {
  /** When a prune happened. A parameter, never a clock read, like every adapter here. */
  readonly now: () => number;
}

export function createPgRecipientResolver(
  db: PgRecipientQueryable,
  options: PgRecipientResolverOptions,
): RecipientResolver {
  return {
    async resolve(row): Promise<ResolvedRecipient> {
      // A row without a subscription could never be sent, and resolving the zone first
      // would only make the reason less specific.
      if (row.channelSubscriptionId === null) {
        return { live: false, reason: 'no channel subscription on the row' };
      }
      const result = await db.query(RESOLVE, [row.watchZoneId, row.channelSubscriptionId]);
      const [found] = result.rows;
      // The inner join to `accounts` means a zone whose account row is gone also lands
      // here; the FK cascades, so in practice it is the zone that is gone.
      if (found === undefined) return { live: false, reason: 'watch zone is gone' };
      if (field(found, 'zone_deleted_at') !== null) {
        return { live: false, reason: 'watch zone was deleted' };
      }
      if (field(found, 'account_deleted_at') !== null) {
        return { live: false, reason: 'account was deleted' };
      }
      if (field(found, 'subscription_id') === null) {
        return { live: false, reason: 'channel subscription is gone' };
      }
      const accountId = string(field(found, 'account_id'), 'account_id');
      const subscriptionAccountId = string(
        field(found, 'subscription_account_id'),
        'subscription_account_id',
      );
      if (subscriptionAccountId !== accountId) {
        throw new TypeError(
          'channel subscription belongs to a different account than the watch zone',
        );
      }
      if (field(found, 'revoked_at') !== null) {
        return { live: false, reason: 'channel subscription was revoked' };
      }
      // Double opt-in (migration 012): pending is never dispatchable.
      if (field(found, 'confirmed_at') === null) {
        return { live: false, reason: 'channel subscription is not confirmed' };
      }
      const endpoint = field(found, 'endpoint');
      // Nulled or emptied at pseudonymization (A1.3): an address we no longer hold.
      if (typeof endpoint !== 'string' || endpoint === '') {
        return { live: false, reason: 'channel subscription has no endpoint' };
      }
      return {
        live: true,
        endpoint,
        channel: subscriptionChannel(field(found, 'channel')),
        timeZone: string(field(found, 'timezone'), 'timezone'),
      };
    },

    async applyDisposition(
      channelSubscriptionId: string,
      disposition: SubscriptionDisposition,
    ): Promise<void> {
      if (disposition === 'keep') return;
      const now = options.now();
      if (!Number.isFinite(now)) {
        throw new RangeError(`now must be a finite epoch, got ${String(now)}`);
      }
      await db.query(REVOKE, [channelSubscriptionId, new Date(now).toISOString()]);
    },
  };
}

function subscriptionChannel(value: unknown): AlertChannel {
  const member = ALERT_CHANNELS.find((channel) => channel === value);
  if (member === undefined) {
    throw new TypeError('channel_subscriptions.channel holds a value outside its vocabulary');
  }
  return member;
}
