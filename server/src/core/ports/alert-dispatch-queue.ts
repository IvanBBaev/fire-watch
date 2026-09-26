/**
 * The read side of the outbox — ADR-004 D1/D2.
 *
 * H1's {@link import('./alert-outbox-store.js').AlertOutboxStore} deliberately offers a
 * write and no send. This is the other half, and it is a separate port rather than two
 * more methods on that one because the two have different owners and different
 * transactions: decisions are written inside the decision transaction by the alert
 * engine, and rows are claimed and settled outside it by the single gateway process.
 * Merging them would put a `claim` method in front of every caller that only ever
 * decides, which is exactly the second sender D2 exists to prevent.
 *
 * **Claiming is a state transition, not a read.** `pending` → `claimed` has to be atomic
 * against a second worker, so the port offers no "list pending" — a caller that could
 * read the queue without claiming it would eventually send from that read.
 */

import type { OutboxRowDraft, OutboxStatus } from './alert-outbox-store.js';

/**
 * A row the gateway now owns — the draft the decision wrote, plus the identity the
 * database gave it. Extending the draft rather than restating twenty columns is not only
 * brevity: A1.1's refusal rule is checked here at dispatch by the same `isDeliverable`
 * that the decision side uses, and two hand-maintained copies of that column list would
 * eventually differ by exactly the provenance field the rule turns on.
 */
export interface ClaimedOutboxRow extends OutboxRowDraft {
  /** `alert_outbox.id`, decimal text — `bigint` does not survive a JS number. */
  readonly id: string;
  /**
   * Epoch ms — `claimed_at`, the `now` this claim was made with (migration 015). The
   * claim is owned for a lease measured from here (`core/alerts/claim-lease.ts`).
   */
  readonly claimedAt: number;
}

/** How a claimed row was disposed of. */
export type SettleOutcome =
  | {
      readonly kind: 'sent';
      /** Epoch ms — `dispatched_at`, when the provider call was made. */
      readonly dispatchedAt: number;
      /** Epoch ms — `provider_ack_at`. */
      readonly providerAckAt: number;
    }
  | {
      /** A terminal close. `status` is one of D1's terminal values. */
      readonly kind: 'closed';
      readonly status: OutboxStatus;
      readonly error: string;
      readonly dispatchedAt: number | null;
    }
  | {
      /**
       * The claim is released and the row returns to the status it had. Used for a
       * transient provider error and for a row that is simply not deliverable *yet* —
       * an over-budget send whose second approver has not arrived.
       */
      readonly kind: 'released';
      readonly error: string | null;
    };

export interface AlertDispatchQueue {
  /**
   * Take up to `limit` rows in A1.2's stored order (`priority, decided_at, id`) and mark
   * them `claimed` in the same statement. `now` is a parameter and never a clock read,
   * so a replayed dispatch claims the same rows. `now` is also the claim's lease start
   * (`claimed_at`, returned as {@link ClaimedOutboxRow.claimedAt}).
   */
  claim(limit: number, now: number): Promise<readonly ClaimedOutboxRow[]>;
  /**
   * Record what happened to one claimed row. Fenced on the claim: a row that is no longer
   * `claimed` *by this claim* — erased, or expired and re-claimed by another dispatcher —
   * is not settled, and the call throws.
   */
  settle(id: string, outcome: SettleOutcome): Promise<void>;
}
