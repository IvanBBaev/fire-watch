/**
 * The raw-file archive, as the backfill core sees it (TASKS B8).
 *
 * Filesystem access and sha256 are platform capabilities, so they arrive through a port
 * like the clock does — which is what lets the resume, integrity and politeness logic be
 * tested against an in-memory store instead of a disk.
 *
 * The atomicity contract lives here because the resume logic depends on it: `writeFile`
 * must publish a file under its final name only once every byte is in it (temp name +
 * rename), so a path that exists is never a partial download. Completion itself is a
 * *manifest* fact — the entry is written only after the rename — so a crash between the
 * two leaves an orphan file that the next run simply re-downloads, never a partial file
 * mistaken for a complete one.
 */

export interface ArchiveWriteResult {
  /** Bytes on disk after the rename — UTF-8 bytes, not string length. */
  readonly bytes: number;
  /** Hex sha256 of exactly those bytes; the manifest records it verbatim. */
  readonly sha256: string;
}

export interface ArchiveStore {
  /** Size in bytes of a published file, or `null` when nothing exists under the name. */
  fileSize(relativePath: string): Promise<number | null>;
  /** Hex sha256 of a published file, or `null` when absent. Used by `--check` — no network. */
  fileSha256(relativePath: string): Promise<string | null>;
  /** Temp name + rename; parent directories are created as needed. */
  writeFile(relativePath: string, contents: string): Promise<ArchiveWriteResult>;
  /** The manifest text, or `null` on a fresh archive. */
  readManifest(): Promise<string | null>;
  /** Same temp-name-plus-rename contract: a crash mid-write leaves the old manifest intact. */
  writeManifest(text: string): Promise<void>;
}
