/**
 * Finds and fetches MTG Lightning Imager flash products (TASKS F18; DATA-SOURCES §F18).
 *
 * The one adapter today is the EUMETSAT Data Store (collection `EO:EUM:DAT:0691`, product
 * type `MTILI2LFL`): a public search, and a download that needs an OAuth2 bearer token.
 * The port hides both, so the refresh job speaks only of 10-minute products.
 *
 * Value-style like the other upstream clients: nothing is thrown, a failure is a value the
 * refresh job records. `status` is the HTTP status when an answer arrived and `null` for
 * a transport failure, so a 401 (a revoked key — an operator problem) is never mistaken
 * for a timeout (the next cycle's problem). Errors are public-safe: no token, no key, no
 * signed URL.
 */

import type { EpochMs } from './clock.js';

/** The half-open sensing window `[startIso, endIso)` of one product, ISO-8601 UTC. */
export interface LightningWindow {
  readonly startIso: string;
  readonly endIso: string;
}

/** One 10-minute LFL product, as the search describes it. */
export interface LightningProduct {
  /** The Data Store product id (the long `W_XX-EUMETSAT-Darmstadt,…` name). */
  readonly id: string;
  readonly window: LightningWindow;
  /** When the Data Store says the product was published, or `null` when it does not say. */
  readonly publishedAtIso: string | null;
  /** The product's md5 as published in the search, or `null` when absent. */
  readonly md5: string | null;
  /** The BODY netCDF-4 entry's name inside the product (`…-CHK-BODY-…-.nc`). */
  readonly bodyName: string;
}

export type LightningSearch =
  | { readonly ok: true; readonly products: readonly LightningProduct[] }
  | { readonly ok: false; readonly status: number | null; readonly error: string };

export type LightningDownload =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      /** Hex sha256 of `bytes`, computed by the adapter (the core does no hashing). */
      readonly sha256: string;
      /** When the bytes arrived — the earliest instant anyone here could know them. */
      readonly availableAt: EpochMs;
    }
  | { readonly ok: false; readonly status: number | null; readonly error: string };

export interface LightningClient {
  /** Products whose sensing window overlaps `window`, newest or oldest first — unordered. */
  search(window: LightningWindow): Promise<LightningSearch>;
  /** The BODY netCDF-4 file of one product. */
  downloadBody(product: LightningProduct): Promise<LightningDownload>;
}
