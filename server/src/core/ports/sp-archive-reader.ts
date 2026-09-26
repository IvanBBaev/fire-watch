/**
 * Read access to the B8 SP archive, as the D7 promotion needs it (TASKS C7).
 *
 * A separate port rather than a widened `ArchiveStore`: promotion only ever reads — the
 * archive is the backfill CLI's to write — and the narrower interface is what lets an
 * in-memory synthetic month be a complete implementation in tests. Integrity of the
 * bytes is not this port's job either: `backfill-cli --check` re-hashes every complete
 * entry against the manifest, and an operator runs it before promoting from a disk
 * nobody has looked at in a while.
 */

export interface SpArchiveReader {
  /** UTF-8 contents of a file under the archive root, or `null` when it is absent. */
  readFile(relativePath: string): Promise<string | null>;
  /** The backfill manifest's text, or `null` when the backfill has never run. */
  readManifest(): Promise<string | null>;
}
