/**
 * Reading back what a {@link PayloadStore} wrote (TASKS F14).
 *
 * A separate port rather than two more methods on `PayloadStore`: the refresh jobs only
 * ever write, and their fakes stay as small as their needs. The wind derivation is the
 * first core consumer that reads recorded payloads — it decodes the stored ECMWF fields.
 *
 * `sha256` is hashed by the adapter from the bytes it returns, because the core has no
 * platform crypto: the caller compares it with the provenance sidecar written next to
 * the payload, so a file damaged on disk is refused instead of decoded.
 */

export interface PayloadRead {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PayloadReader {
  /** The whole file, or `null` when nothing exists at the path. Throws on store failure. */
  readPayload(relativePath: string): Promise<PayloadRead | null>;
  /** UTF-8 text, or `null` when absent. */
  readText(relativePath: string): Promise<string | null>;
}
