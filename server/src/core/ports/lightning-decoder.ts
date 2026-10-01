/**
 * Turns one MTG LI LFL BODY file into untrusted payload text (TASKS F18).
 *
 * The same contract as `GranuleDecoder`, with its own ref: a lightning product is
 * not a detection granule — it has no registered `SourceId` and never becomes a
 * detection — so it does not borrow the fire granule's types. `slotIso` carries the
 * product's sensing window as an ISO-8601 interval, `start/end`, which the decoder
 * checks every flash time against.
 *
 * As with fire granules: a decode is a result, never an exception; the payload is text
 * the core parses (`parseLightningPayload`) and trusts no further than that parse; the
 * decoder holds no credentials.
 */

import type { DecodeResult } from './granule-decoder.js';

export const LIGHTNING_SOURCE = 'eumetsat:mtg-li:lfl';
export const LIGHTNING_KIND = 'lightning-flashes';

export interface LightningGranuleRef {
  readonly source: typeof LIGHTNING_SOURCE;
  readonly kind: typeof LIGHTNING_KIND;
  /** `<window start>/<window end>`, both ISO-8601 UTC. */
  readonly slotIso: string;
  /** The BODY entry name, for the diagnostics only. */
  readonly name: string;
}

export interface LightningDecoder {
  decode(ref: LightningGranuleRef, bytes: Uint8Array): Promise<DecodeResult>;
}
