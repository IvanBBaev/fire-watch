/**
 * Zone-centre key rotation's view of `watch_zones` (TASKS I2; 05 §5.3.2), as a port.
 *
 * Only the sealed columns cross it — `centre_ciphertext`, `centre_key_id` — plus the zone
 * id the ciphertext is bound to. Every row with a sealed centre is in scope, soft-deleted
 * ones included: a retired key can only be dropped once *no* row names it, and a
 * soft-deleted zone still holds a ciphertext until the erasure purge removes the row.
 */

import type { SealedCentre } from './zone-centre-cipher.js';

export interface SealedZoneCentre {
  readonly zoneId: string;
  readonly sealed: SealedCentre;
}

/** One row moved to the active key: compare-and-swap from `from` to `to`. */
export interface ZoneCentreReplacement {
  readonly zoneId: string;
  readonly from: SealedCentre;
  readonly to: SealedCentre;
}

/** The statements of one batch, all on one transaction. */
export interface ZoneCentreRekeyBatch {
  /**
   * Up to `limit` rows whose `centre_key_id` is not `activeKeyId`, ordered by zone id,
   * strictly after `afterZoneId` when it is non-null, locked for the transaction.
   */
  lockNotUnder(
    activeKeyId: string,
    afterZoneId: string | null,
    limit: number,
  ): Promise<readonly SealedZoneCentre[]>;
  /**
   * Writes each replacement only where the row still holds exactly `from` (key id and
   * bytes). Resolves the number of rows changed; a row that moved in between is left alone.
   */
  replace(replacements: readonly ZoneCentreReplacement[]): Promise<number>;
}

export interface ZoneCentreRekeyStore {
  /**
   * Runs `work` in one transaction: committed when it resolves, rolled back when it throws.
   * Each batch is its own transaction, so a stopped run keeps every batch it finished.
   */
  inBatch<T>(work: (batch: ZoneCentreRekeyBatch) => Promise<T>): Promise<T>;
  /** Sealed rows per `centre_key_id`, soft-deleted rows included. */
  countByKeyId(): Promise<ReadonlyMap<string, number>>;
}
