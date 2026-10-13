/**
 * Where an address SES says is dead (a hard bounce) or unwanted (a complaint) goes —
 * the write side of `core/alerts/email-feedback.ts` (04-sre §5 "deliverability hygiene").
 *
 * A port of its own rather than a method on `RecipientResolver`: the resolver's prune is
 * keyed by a subscription the gateway just resolved, while feedback arrives keyed only by
 * an address, minutes or days after the send, and may name an address that is on several
 * subscriptions — or on none, when the mail was a sign-in link.
 */

import type { EpochMs } from './clock.js';

export interface EmailSuppressor {
  /**
   * Stops every live email subscription whose endpoint is `address` (already normalized
   * the way endpoints are stored) as of `at`, and returns how many it stopped. Idempotent:
   * SNS delivers at least once, and a second delivery must stop nothing new.
   */
  suppress(address: string, at: EpochMs): Promise<number>;
}
