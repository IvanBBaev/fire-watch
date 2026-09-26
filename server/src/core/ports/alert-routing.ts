/**
 * Where a decided alert goes and what it says (TASKS H2), as the live evaluation cycle
 * needs it.
 *
 * `outboxRowFor` takes a channel, a subscription and a template from its caller because
 * each belongs to a different owner (`core/alerts/outbox.ts`). This port is that caller's
 * source for them. There is **no production implementation**: which of an account's
 * channels one decision is delivered on is H2's open question (the A1.11 key has no
 * channel column, so one decision is one delivery), and D7's reviewed-template registry is
 * still empty. The live loop's wiring therefore stays disabled until both exist, rather
 * than inventing a channel or a template id that the never-send lint has never read.
 */

import type { AlertDecision, AlertableEvent, AlertZone } from '../alerts/alert-decision.js';
import type { AlertLocale } from '../alerts/templates/alert-copy.js';
import type { AlertChannel } from './alert-outbox-store.js';

export interface AlertDeliveryTarget {
  readonly channel: AlertChannel;
  /** `channel_subscriptions.id`, or `null` for a channel with no subscription row. */
  readonly channelSubscriptionId: string | null;
  /**
   * The language to write the rows in (migration 015). Absent means the outbox default
   * (`DEFAULT_OUTBOX_LOCALE`, `bg`) — which is every target until the account or the
   * subscription holds a language.
   */
  readonly locale?: AlertLocale;
}

export interface AlertCopy {
  readonly templateId: string;
  /** Bound parameters, never a rendered body (A1.3). */
  readonly templateParams: Readonly<Record<string, unknown>>;
}

export interface AlertRouting {
  /**
   * The one delivery target for this account's automatic alerts, or `null` when it has
   * none. A `null` target makes every `send` for the account undeliverable, and the cycle
   * then writes nothing for that (account, event) — see `evaluation-cycle.ts`.
   */
  targetFor(accountId: string): Promise<AlertDeliveryTarget | null>;
  /** The reviewed copy for a `send`, or `null` when no reviewed template covers it. */
  copyFor(decision: AlertDecision, event: AlertableEvent, zone: AlertZone): AlertCopy | null;
}
