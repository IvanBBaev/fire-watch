/**
 * Where a granule's bytes come from.
 *
 * Deliberately separate from the decoder: fetching is a network problem with credentials
 * and rate limits, decoding is a parser problem with a sandbox around it, and the whole
 * point of E3 is that the second never gets to be the first. An implementation of this
 * port holds the LSA SAF account; the decoder never sees it.
 *
 * As with the FIRMS client, the core says *which slot*, never which URL — the address
 * scheme is the provider's business and it has changed before.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { EpochMs } from './clock.js';

/**
 * `missing` is not `failed`. A geostationary slot that is late, or that the provider never
 * produced, is an ordinary gap in a fixed grid and the archive should record it as one; a
 * timeout or a 500 is an outage of ours to alert on. Collapsing them would make a quiet
 * provider indistinguishable from a broken one — pitfall 10, in its GEO form.
 */
export type GranuleFetchOutcome = 'ok' | 'missing' | 'failed';

export interface GranuleFetch {
  readonly outcome: GranuleFetchOutcome;
  /** The delivered bytes, verbatim and undecompressed. `null` unless `ok`. */
  readonly bytes: Uint8Array | null;
  /** The provider's filename, for the archive and for quarantine. `null` unless `ok`. */
  readonly name: string | null;
  /** When the bytes were in our hands. `null` when nothing arrived. */
  readonly availableAt: EpochMs | null;
  /** Redacted and capped by the adapter. `null` on `ok`. */
  readonly error: string | null;
}

export interface GranuleSource {
  fetchSlot(source: SourceId, slotIso: string): Promise<GranuleFetch>;
}
