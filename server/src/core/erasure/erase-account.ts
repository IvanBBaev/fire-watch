/**
 * Account erasure as one ordered sequence (TASKS I4; ADR-004 D8, A1.3, A1.9; 14 M3).
 *
 * The pg adapter runs this inside a single transaction, so either every step lands or
 * none does. **The order is the locking order**, and each step is where it is for a
 * reason:
 *
 *   1. Lock the account. A second erasure, a sign-in, or a zone write for the same account
 *      waits here (migration 010's triggers take a share lock on the account row).
 *   2. Lock the zones, soft-deleted ones included. From here on, an alert decision racing
 *      the erasure blocks on its foreign-key check against the zone and then fails.
 *   3. Cancel and pseudonymize the outbox (A1.9 + A1.3). A pending row locked by a claim in
 *      flight is waited for, then found `claimed` and cancelled all the same; a row this
 *      statement holds is skipped by any claim (`SKIP LOCKED`) and is `cancelled_erasure`
 *      by the time the lock is released. A dispatcher that claimed a row before step 3
 *      finds its settle refused, because every settle is conditional on `status = 'claimed'`.
 *   4. Delete alert state, then the zones (the shadow log goes with them by cascade).
 *   5. Delete channel confirmations (migration 012), then subscriptions, sessions and link
 *      requests.
 *   6. Tombstone the account, then write the ledger row.
 *
 * Nothing here reads a clock; `at` is passed in.
 */

import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { AccountErasureStore, ErasureCounts } from '../ports/account-erasure-store.js';
import { ERASURE_HORIZON, erasureDeadline, type ErasureHorizon } from './erasure-horizon.js';
import { ERASURE_PLAN_VERSION, RETAINED_TEMPLATE_PARAM_KEYS } from './erasure-plan.js';

export type ErasureOutcome =
  | {
      readonly status: 'erased';
      readonly erasedAt: EpochMs;
      /** Every personal backup artifact made before `erasedAt` is gone by this instant. */
      readonly deadline: EpochMs;
      readonly counts: ErasureCounts;
    }
  /** Idempotent: a second request for an erased account changes nothing. */
  | { readonly status: 'already_erased' }
  | { readonly status: 'missing' };

export interface EraseAccountOptions {
  readonly horizon?: ErasureHorizon;
  readonly retainedParamKeys?: readonly string[];
}

export async function eraseAccount(
  accountId: string,
  at: EpochMs,
  store: AccountErasureStore,
  options: EraseAccountOptions = {},
): Promise<ErasureOutcome> {
  const account = await store.lockAccount(accountId);
  if (account.state === 'missing') return { status: 'missing' };
  if (account.state === 'erased') return { status: 'already_erased' };

  const atIso = isoFromEpochMs(at);
  const zoneIds = await store.lockZones(accountId);

  const outbox =
    zoneIds.length === 0
      ? { cancelled: 0, pseudonymized: 0 }
      : await store.cancelAndPseudonymizeOutbox(
          zoneIds,
          atIso,
          options.retainedParamKeys ?? RETAINED_TEMPLATE_PARAM_KEYS,
        );
  const alertStates = zoneIds.length === 0 ? 0 : await store.deleteAlertStates(zoneIds);
  const zones =
    zoneIds.length === 0
      ? { zones: 0, shadowAlerts: 0, decisionLog: 0, digestLog: 0 }
      : await store.deleteZones(zoneIds);

  const channelConfirmations = await store.deleteChannelConfirmations(accountId);
  const subscriptions = await store.deleteSubscriptions(accountId);
  const sessions = await store.deleteSessions(accountId);
  const linkRequests = account.email === null ? 0 : await store.deleteLinkRequests(account.email);

  await store.tombstoneAccount(accountId, atIso);

  const counts: ErasureCounts = {
    outboxCancelled: outbox.cancelled,
    outboxPseudonymized: outbox.pseudonymized,
    alertStates,
    shadowAlerts: zones.shadowAlerts,
    decisionLog: zones.decisionLog,
    digestLog: zones.digestLog,
    zones: zones.zones,
    channelConfirmations,
    subscriptions,
    sessions,
    linkRequests,
  };
  const deadline = erasureDeadline(at, options.horizon ?? ERASURE_HORIZON);
  await store.record({
    accountId,
    erasedAtIso: atIso,
    deadlineIso: isoFromEpochMs(deadline),
    planVersion: ERASURE_PLAN_VERSION,
    counts,
  });
  return { status: 'erased', erasedAt: at, deadline, counts };
}
