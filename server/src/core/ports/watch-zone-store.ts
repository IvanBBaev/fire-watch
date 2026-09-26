/**
 * Watch-zone persistence, as the core sees it (TASKS I2; 05 §5.3.2; ADR-004 D8, A1.10).
 *
 * Everything that crosses this port about *where* a zone is has already been through
 * `core/zones/zone-geometry.ts` and the {@link ZoneCentreCipher}: a sealed centre, a key id,
 * and the ~5 km index cell. There is no field on {@link NewWatchZone} that could carry a
 * plaintext coordinate, which is the point — "the stored row contains no coordinate" is a
 * property of this type before it is a property of any test.
 *
 * **No transaction of its own.** A1.8 requires the zone write and its seed plan to commit
 * together, so the adapter's handle is structural and the caller hands this store and the
 * `AlertStateStore` the same client after a `BEGIN` — the same shape the alert-state and
 * outbox stores already have.
 *
 * **Account-scoped by construction.** Every read and delete that a user can trigger takes
 * the account id, so a zone id guessed from another account's URL is simply not found. The
 * one unscoped read, {@link WatchZoneStore.listLiveInCells}, is for the matcher, which is a
 * system actor and has no account to scope by.
 */

import type { SealedCentre } from './zone-centre-cipher.js';

/** What a zone creation writes. The id is chosen by the caller: the cipher binds it. */
export interface NewWatchZone {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly radiusM: number;
  readonly minScore: number;
  readonly sealed: SealedCentre;
  /** Whether the sealed centre is the ~1 km snapped one (ADR-004 D8's default). */
  readonly coarsened: boolean;
  readonly gridVersion: string;
  readonly gridCell: string;
  /** The transaction's instant; the same one the seed plan stamps. */
  readonly createdAtIso: string;
}

/** A live, sealed zone as read back. Legacy plaintext-`area` rows are never returned. */
export interface StoredWatchZone {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly radiusM: number;
  readonly minScore: number;
  readonly sealed: SealedCentre;
  readonly coarsened: boolean;
  readonly gridVersion: string;
  readonly gridCell: string;
  readonly createdAtIso: string;
}

/**
 * The account-level half of `AlertZone`: quiet hours and the time zone they are read in
 * live on `accounts`, not on the zone (001). `HH:MM`, the vocabulary `isInQuietHours`
 * reads.
 */
export interface AccountAlertSettings {
  readonly timezone: string;
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
  readonly newFireOverridesQuietHours: boolean;
}

export interface WatchZoneStore {
  /**
   * The account's alert settings, or `null` when the account does not exist or is
   * soft-deleted — which is also the "may this account create a zone at all" check, since
   * the foreign key alone would accept a zone on a deleted account.
   */
  loadAccountAlertSettings(accountId: string): Promise<AccountAlertSettings | null>;
  insert(zone: NewWatchZone): Promise<void>;
  /** The account's live sealed zones, oldest first. */
  listForAccount(accountId: string): Promise<readonly StoredWatchZone[]>;
  /**
   * Live sealed zones whose index cell is one of these, under this grid version. The
   * candidate half of 05 §5.3.2's lookup; the precise test decrypts what this returns.
   */
  listLiveInCells(
    gridVersion: string,
    cells: readonly string[],
  ): Promise<readonly StoredWatchZone[]>;
  /**
   * Soft-deletes one of the account's zones. `false` when there was no such live zone —
   * absent, already deleted, or someone else's, deliberately indistinguishable.
   */
  softDelete(accountId: string, zoneId: string, atIso: string): Promise<boolean>;
}
