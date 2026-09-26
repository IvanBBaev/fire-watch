/**
 * The port account erasure is written against (TASKS I4; migration 010).
 *
 * **The store opens no transaction.** `core/erasure/erase-account.ts` is a plain sequence
 * over these calls and the pg adapter runs the whole sequence inside one `BEGIN … COMMIT`;
 * the order of the calls is the locking order, and it is the core's to state.
 *
 * Times cross as ISO-8601 strings, the codebase's convention for timestamptz binds.
 */

export type LockedAccount =
  | { readonly state: 'missing' }
  | { readonly state: 'erased' }
  | { readonly state: 'live'; readonly email: string | null };

export interface OutboxErasureCounts {
  /** Rows moved from pending, awaiting_approval or claimed to cancelled_erasure. */
  readonly cancelled: number;
  /** Rows rewritten under A1.3 — the cancelled ones and every already-final row. */
  readonly pseudonymized: number;
}

export interface ErasureCounts {
  readonly outboxCancelled: number;
  readonly outboxPseudonymized: number;
  readonly alertStates: number;
  readonly shadowAlerts: number;
  /** `alert_decision_log` rows (migration 014) the zone cascade removed. */
  readonly decisionLog: number;
  /** `alert_digest_log` rows (migration 018) the zone cascade removed. */
  readonly digestLog: number;
  readonly zones: number;
  /** `channel_confirmations` rows (migration 012), pending Telegram links included. */
  readonly channelConfirmations: number;
  readonly subscriptions: number;
  readonly sessions: number;
  readonly linkRequests: number;
}

export interface ErasureRecord {
  readonly accountId: string;
  readonly erasedAtIso: string;
  readonly deadlineIso: string;
  readonly planVersion: string;
  readonly counts: ErasureCounts;
}

export interface AccountErasureStore {
  /** Row-locks the account (`FOR UPDATE`) and says what state it is in. */
  lockAccount(accountId: string): Promise<LockedAccount>;
  /**
   * Row-locks every zone of the account, soft-deleted ones included, and returns their
   * ids. Taken before the outbox is touched, so an alert write racing the erasure waits on
   * its foreign-key check and then fails, instead of landing after the outbox statement.
   */
  lockZones(accountId: string): Promise<readonly string[]>;
  cancelAndPseudonymizeOutbox(
    zoneIds: readonly string[],
    atIso: string,
    retainedParamKeys: readonly string[],
  ): Promise<OutboxErasureCounts>;
  deleteAlertStates(zoneIds: readonly string[]): Promise<number>;
  /**
   * Deletes the zones; `shadowAlerts`, `decisionLog` and `digestLog` are what the cascades
   * into `alerts_shadow`, `alert_decision_log` and `alert_digest_log` removed.
   */
  deleteZones(zoneIds: readonly string[]): Promise<{
    readonly zones: number;
    readonly shadowAlerts: number;
    readonly decisionLog: number;
    readonly digestLog: number;
  }>;
  /**
   * Deletes every double-opt-in confirmation of the account (migration 012). Before the
   * subscriptions: a pending Telegram link names no subscription, so their cascade would
   * leave it behind.
   */
  deleteChannelConfirmations(accountId: string): Promise<number>;
  deleteSubscriptions(accountId: string): Promise<number>;
  deleteSessions(accountId: string): Promise<number>;
  deleteLinkRequests(email: string): Promise<number>;
  tombstoneAccount(accountId: string, atIso: string): Promise<void>;
  record(entry: ErasureRecord): Promise<void>;
}
