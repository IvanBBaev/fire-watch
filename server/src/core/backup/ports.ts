/**
 * The ports of the nightly backup job and its restore (TASKS C6).
 *
 * Kept beside the job rather than in `core/ports/` because nothing else uses them. Every
 * one is implemented twice: by the adapters in `adapters/backup/` (child processes, R2)
 * and by fakes in the tests.
 */

import type { ClassifiedRelation } from './dump-plan.js';
import type { RelationRowCount } from './restore-verify.js';
import type { ListedObject } from './retention.js';
import type { TableGaugeSnapshot, TableStat } from './table-gauges.js';

export interface SnapshotLease {
  /** The `pg_export_snapshot()` id both dumps pass as `--snapshot`. */
  readonly snapshotId: string;
  /** Ends the exporting transaction. Idempotent. */
  release(): Promise<void>;
}

export interface BackupDatabase {
  /** Every table in `public` (partitions included), with its registry class or null. */
  classifiedRelations(): Promise<readonly ClassifiedRelation[]>;
  /** `schema_migrations` versions, for the artifact's metadata. */
  appliedMigrations(): Promise<readonly string[]>;
  /** Opens a REPEATABLE READ transaction and exports its snapshot. */
  exportSnapshot(): Promise<SnapshotLease>;
  /**
   * Rows (counted inside the exported snapshot, so exactly what the dumps carry) and
   * on-disk bytes of every leaf table in `public`. Called while the lease is held.
   */
  tableStats(snapshotId: string): Promise<readonly TableStat[]>;
}

/**
 * The previous night's table gauges, kept on the host between runs so tonight's can be
 * compared with them. Written only after every upload landed: a failed night is not the
 * baseline for the next one.
 */
export interface TableGaugeLedger {
  /** The last recorded snapshot, or null when there is none (or it is unreadable). */
  read(): Promise<TableGaugeSnapshot | null>;
  write(snapshot: TableGaugeSnapshot): Promise<void>;
}

export interface StagedArtifact {
  /** The encrypted file on local disk (0600). */
  readonly path: string;
  readonly bytes: number;
  /** Lower-case hex SHA-256 of the encrypted bytes. */
  readonly sha256: string;
}

export interface ArtifactProducer {
  /** `pg_dump <args> | age -r <recipient>` into the staging directory, hashed on the way. */
  dumpEncrypted(input: {
    readonly fileName: string;
    readonly pgDumpArgs: readonly string[];
  }): Promise<StagedArtifact>;
  /** Deletes every staged artifact except `keep` (absolute paths). */
  pruneStaging(keep: readonly string[]): Promise<void>;
}

export interface BackupObjectWriter {
  /** One signed PUT of the staged bytes; the store checks the SHA-256 it was signed with. */
  upload(
    key: string,
    artifact: StagedArtifact,
    metadata: Readonly<Record<string, string>>,
  ): Promise<{ readonly etag: string | null }>;
}

export interface FetchedArtifact {
  readonly key: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  /** The `sha256` the job recorded at upload, or null when the object carries none. */
  readonly recordedSha256: string | null;
}

export interface BackupObjectReader {
  list(prefix: string): Promise<readonly ListedObject[]>;
  /** GET into a local file (0600); null when the object does not exist. */
  download(key: string, destinationPath: string): Promise<FetchedArtifact | null>;
}

/**
 * The paging leg (OPERATIONS §1.3 `nightly-backup`, §3 rule 5): `succeeded` only after
 * every upload landed, `failed` from the failure path — never from a `finally`. Both
 * resolve either way; a monitor must not fail the job it monitors.
 */
export interface BackupPinger {
  succeeded(): Promise<void>;
  failed(): Promise<void>;
}

/** The restore side's database: a scratch target, never production. */
export interface RestoreTarget {
  /** Refuses when the database already exists: a restore never lands on top of data. */
  createDatabase(name: string): Promise<void>;
  /** `age -d -i <identity> <file> | pg_restore --dbname=<name> <args>`. */
  restore(input: {
    readonly database: string;
    readonly artifactPath: string;
    readonly pgRestoreArgs: readonly string[];
  }): Promise<void>;
  appliedMigrations(database: string): Promise<readonly string[]>;
  rowCounts(database: string): Promise<readonly RelationRowCount[]>;
}

/**
 * Where the restore puts what it downloads. A downloaded personal artifact is a copy of
 * personal rows with no lifecycle rule, so the restore discards every download when it
 * ends, whatever the outcome — that is cleanup, and it belongs in a `finally`.
 */
export interface RestoreWorkspace {
  /** Absolute path for a downloaded artifact of this file name. */
  pathFor(fileName: string): string;
  /** Deletes a downloaded file. Idempotent: a path that is already gone is not an error. */
  discard(path: string): Promise<void>;
}
