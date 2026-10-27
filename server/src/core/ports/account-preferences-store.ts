/**
 * The synced-preferences store (TASKS V2-C5; migration 034).
 *
 * One row per account: the document the web client last wrote and its revision. Every
 * write names the revision it was based on, and the store moves the row only if that is
 * still the stored one — the optimistic concurrency the `If-Match` header carries on the
 * wire. A write that loses answers `null`; nothing is merged here, the client merges.
 *
 * **Each call is one statement**, so the store needs no transaction: the conditional
 * UPDATE (or the first INSERT) is atomic on its own, and two devices writing from the same
 * revision cannot both win.
 *
 * Times cross as ISO-8601 strings on writes.
 */

export interface StoredAccountPreferences {
  /** At least 1: a row exists only once something was written. */
  readonly revision: number;
  /** The `jsonb` as stored — the caller validates it again before serving it. */
  readonly document: unknown;
}

export interface AccountPreferencesStore {
  /** The account's stored preferences, or `null` when it never wrote any. */
  read(accountId: string): Promise<StoredAccountPreferences | null>;
  /**
   * Store `document` if the stored revision is still `expectedRevision` (`0`: nothing is
   * stored yet). Answers the new revision, or `null` when another write got there first.
   */
  write(
    accountId: string,
    document: unknown,
    expectedRevision: number,
    atIso: string,
  ): Promise<number | null>;
}
