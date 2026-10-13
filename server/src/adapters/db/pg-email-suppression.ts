/**
 * The email suppression, over Postgres: one conditional `UPDATE` that stops every live
 * email subscription on an address SES reported as a hard bounce or a complaint
 * (`core/ports/email-suppressor.ts`, `core/alerts/email-feedback.ts`).
 *
 * **Stopping is `revoked_at`.** It is the same column a provider-side `prune` writes
 * (`pg-recipient-resolver.ts`), and for the same reason: the recipient resolver refuses a
 * revoked subscription at dispatch time, so the next alert for the address closes
 * instead of being sent into the bounce. No new column, no new status — a deliberate
 * choice for now, recorded in TASKS H5: the "your alerts stopped working" notice will need
 * to tell a bounce-revoked channel from one the person unlinked, and that is where a
 * `revoked_reason` would come in; the notice has no design yet, so the column has no
 * consumer and is not added ahead of it.
 *
 * **Every subscription on the address, pending ones included.** An address can sit on
 * several accounts (each opted in on its own), and an unconfirmed subscription whose
 * confirmation mail bounced is the clearest case of all for stopping it. Only `email`
 * rows are touched; a Telegram chat id cannot equal an address, but the predicate says so
 * rather than relying on it.
 *
 * **Equality on the stored form.** The address arrives normalized by `normalizeEmail`,
 * which is how opt-in wrote the endpoint, so the match is `endpoint = $1` — no `lower()`
 * on the column, which would hide a normalization disagreement instead of exposing it.
 * Pseudonymized endpoints (null or empty, A1.3) never match. There is no index on
 * `endpoint`: the table is one row per channel per person, feedback arrives at
 * human rates, and a sequential scan of it is cheaper than an index every opt-in pays
 * for. Revisit if the table grows past what a scan per bounce should cost.
 *
 * Conditional on `revoked_at IS NULL`, so SNS's at-least-once redelivery keeps the first
 * instant and reports zero the second time — the instant says when we stopped writing to
 * that address.
 */

import type { EmailSuppressor } from '../../core/ports/email-suppressor.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgEmailSuppressionQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
}

const SUPPRESS = `
UPDATE channel_subscriptions
SET revoked_at = $2::timestamptz
WHERE channel = 'email' AND endpoint = $1 AND revoked_at IS NULL`;

/** Exported for the tests that assert the statement's shape rather than its effect. */
export const EMAIL_SUPPRESSION_SQL = { suppress: SUPPRESS } as const;

export function createPgEmailSuppression(db: PgEmailSuppressionQueryable): EmailSuppressor {
  return {
    async suppress(address, at) {
      if (address === '') throw new TypeError('suppress needs a non-empty address');
      if (!Number.isFinite(at)) throw new TypeError('suppress needs a finite instant');
      const result = await db.query(SUPPRESS, [address, new Date(at).toISOString()]);
      return result.rowCount ?? 0;
    },
  };
}
