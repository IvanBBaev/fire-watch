/**
 * The seam between us and whatever ends up decoding a binary product granule.
 *
 * LSA SAF ships FRP-PIXEL as HDF5 (LSA-502) and netCDF-4 (LSA-509), and both are read by
 * native C libraries with a long CVE history — review 05 calls this "the only parser in
 * the roadmap worth sandboxing" (E3), and review 02 R-9 defers the *implementation*
 * (h5wasm in-process vs a Python sidecar) while insisting the *boundary* be drawn now, or
 * the deferral leaks into the core. This file is that boundary.
 *
 * Three rules make the choice invisible to everything upstream:
 *
 * 1. **A decode is a result, never an exception.** A granule that crashes the decoder, or
 *    hangs it, or answers with a gigabyte of nonsense, produces a `DecodeResult` with an
 *    outcome saying so. There is no failure mode of a hostile file that reaches the ingest
 *    cycle as a thrown error, because a thrown error is one `catch` away from being a
 *    crash loop against a granule the provider will keep serving.
 *
 * 2. **The output is still untrusted.** It was produced by code that just parsed hostile
 *    bytes; if that code was compromised, its JSON is the attacker's JSON. The decoder
 *    hands back *text*, and `parseGranulePayload` in the core is what turns text into
 *    values — never `JSON.parse` at the adapter, never a typed object across the boundary.
 *
 * 3. **The decoder holds no credentials.** It gets bytes and gives back text. It cannot
 *    reach the database, because it is never told where the database is (05 §5.6.2 E3).
 */

import type { SourceId } from '@fire-watch/contracts';

/** What a granule is expected to contain, so the payload can be checked against it. */
export type GranuleKind = 'frp' | 'cloud-mask';

export interface GranuleRef {
  /** The §1a canonical source the rows will be attributed to. */
  readonly source: SourceId;
  readonly kind: GranuleKind;
  /**
   * The nominal acquisition slot, `YYYY-MM-DDTHH:MM:00Z`. Geostationary products are
   * published on a fixed repeat cycle, so the slot is known before the file is: it is how
   * a granule is addressed, and how a gap in the archive is named.
   */
  readonly slotIso: string;
  /** The provider's filename, kept verbatim for the archive and for quarantine. */
  readonly name: string;
}

/**
 * Why a decode did not produce a payload. Each one is a different operational story and
 * they must not collapse into "failed": `crashed` and `timed_out` are a poisoned-granule
 * signal worth alerting on, `refused` is the decoder declining a file it could read well
 * enough to reject, and `oversized` is the one that would have taken the parent down with
 * it if the cap had not been there.
 */
export type DecodeOutcome =
  'ok' | 'refused' | 'crashed' | 'timed_out' | 'oversized' | 'unavailable';

export interface DecodeResult {
  readonly outcome: DecodeOutcome;
  /**
   * The decoder's raw answer, as text. Present on `ok` and, when there was one, on
   * `refused` — a decoder that explains itself in JSON is worth quarantining verbatim.
   */
  readonly payload: string | null;
  /** A redacted, length-capped diagnosis. `null` only on `ok`. */
  readonly error: string | null;
  /** Wall-clock milliseconds the decode took, including process start. */
  readonly durationMs: number;
  /** Bytes the decoder wrote before it was cut off, so a flood is visible as a number. */
  readonly bytesOut: number;
}

/**
 * One granule in, one result out. Implementations are expected to be safe to call
 * concurrently, and to be as expensive as starting a process — which is what the cadence
 * planner budgets for.
 */
export interface GranuleDecoder {
  decode(ref: GranuleRef, bytes: Uint8Array): Promise<DecodeResult>;
}
