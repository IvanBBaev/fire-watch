/**
 * Where fetched context payloads land (TASKS C4).
 *
 * Deliberately not {@link ArchiveStore} (B8): that port speaks strings because CSV is
 * text, and forcing a PNG or a GRIB2 message through a string round-trip is how a byte
 * goes missing without anyone noticing. This port speaks bytes, plus text for the
 * provenance sidecars that travel next to them.
 *
 * The same atomicity promise as the archive: a path that exists holds a whole file,
 * never a partial one. The EFFIS proxy's serve-stale behaviour stands on that — the
 * "last known good" copy must be replaced in one rename or not at all, because a
 * half-written overlay served during a refresh is exactly the poisoned cache A2.2
 * exists to prevent.
 */

export interface PayloadWriteResult {
  readonly bytes: number;
  /** Hashed from the same buffer that was written, for the provenance sidecar. */
  readonly sha256: string;
}

export interface PayloadStore {
  /** Whether a whole file exists at this path. Never true for a write in progress. */
  exists(relativePath: string): Promise<boolean>;
  /** Writes atomically; a reader never observes a partial file. Throws on store failure. */
  writePayload(relativePath: string, bytes: Uint8Array): Promise<PayloadWriteResult>;
  /** UTF-8 text — the provenance sidecars. Same atomicity as {@link writePayload}. */
  writeText(relativePath: string, text: string): Promise<PayloadWriteResult>;
}
