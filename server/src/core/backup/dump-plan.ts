/**
 * What one nightly backup run dumps, and under which keys (TASKS C6; OPERATIONS §6.2
 * rules 1, 4, 5, 8).
 *
 * Two artifacts from **one** exported snapshot (§6.2 rule 5, WP7):
 *
 *   * **main** — the whole schema, and the rows of every `main`-class table. Personal
 *     tables keep their DDL (`--exclude-table-data`), so a restore of a main artifact
 *     alone yields the personal tables present and empty (rule 8).
 *   * **personal** — `--data-only` over exactly the personal tables. Kept 28 days, inside
 *     the 30-day erasure horizon; the main set is kept 56.
 *
 * The class of each table comes from the `table_backup_class` registry (migration 001 and
 * every migration since). **Fail-closed:** a table the registry does not name is treated
 * as personal — its rows stay out of the long-lived main set — and is reported, so the
 * omission is fixed in a migration rather than discovered in a drill. Partitions inherit
 * their root's class (the adapter's query resolves that).
 *
 * The rows of `alert_outbox` are personal and so are *absent* from the main set. The
 * pseudonymized COPY projection rule 7 describes (retained-verbatim columns only) is not
 * built: its mapping onto the real columns is an open question, and absent is the safe
 * side of it.
 *
 * Pure: the relation list, snapshot id and instant arrive as arguments.
 */

import type { EpochMs } from '../ports/clock.js';
import { backupObjectKey, type BackupObjectKey, type BackupSet } from './backup-keys.js';
import { BACKUP_RETENTION, tiersFor, type BackupRetentionPolicy } from './retention.js';

export type BackupClass = 'main' | 'personal';

export interface ClassifiedRelation {
  /** Unqualified name in the `public` schema. */
  readonly relation: string;
  /** From `table_backup_class` (through the partition root), or null: unclassified. */
  readonly backupClass: BackupClass | null;
}

export interface PlannedArtifact {
  readonly set: BackupSet;
  /** The daily key first; a Sunday adds the weekly key — the same bytes, uploaded twice. */
  readonly keys: readonly BackupObjectKey[];
  /** pg_dump arguments after the connection ones. */
  readonly pgDumpArgs: readonly string[];
  /** The tables whose rows this artifact carries, sorted. */
  readonly tablesWithData: readonly string[];
  /** Smaller than this after encryption is refused as a failed dump, not uploaded. */
  readonly minBytes: number;
}

export interface BackupRunPlan {
  readonly takenAtMs: EpochMs;
  readonly snapshotId: string;
  readonly artifacts: readonly PlannedArtifact[];
  /** Tables missing from the registry, dumped as personal (fail-closed). */
  readonly unclassified: readonly string[];
}

/**
 * The shell job's floor, kept: a dump this small is a failure that would otherwise upload
 * happily and be found at the quarterly drill (§6.3). The personal floor is lower because
 * a young deployment's personal set is legitimately tiny; the age header alone is ~200 B.
 */
export const MIN_MAIN_ARTIFACT_BYTES = 4096;
export const MIN_PERSONAL_ARTIFACT_BYTES = 512;

/** Custom format (for pg_restore), light compression — the shell job's `-Fc -Z 3`. */
export const PG_DUMP_BASE_ARGS = ['--format=custom', '--compress=3', '--no-password'] as const;

/**
 * Tables created by tooling rather than by a migration, so no migration can have registered
 * them before they held rows. Applied only when the registry is silent: a registry row
 * always wins. `schema_migrations` is dbmate's ledger; left to the fail-closed default it
 * would travel as personal, and a main artifact restored alone (§6.2 rule 8) would come
 * back with no migration history — failing the drill's schema check (§6.3) for a table
 * that holds nothing but version numbers. Migration 013 registers it, so on a current
 * database the registry row answers first; the entry stays for a database — or a restored
 * artifact — from before 013.
 */
export const TOOLING_RELATION_CLASS: Readonly<Record<string, BackupClass>> = {
  schema_migrations: 'main',
};

/** A plain lower-case identifier: safe as a pg_dump pattern without quoting or globbing. */
const RELATION_RE = /^[a-z_][a-z0-9_]{0,62}$/;
/** `pg_export_snapshot()` output, e.g. `00000003-0000001B-1`. */
const SNAPSHOT_RE = /^[0-9A-F]{8}-[0-9A-F]{8}-[0-9]{1,10}$/;

export function isValidSnapshotId(id: string): boolean {
  return SNAPSHOT_RE.test(id);
}

export function planBackupRun(input: {
  readonly relations: readonly ClassifiedRelation[];
  readonly snapshotId: string;
  readonly takenAtMs: EpochMs;
  readonly policy?: BackupRetentionPolicy;
}): BackupRunPlan {
  const policy = input.policy ?? BACKUP_RETENTION;
  if (!isValidSnapshotId(input.snapshotId)) {
    throw new RangeError('snapshot id is not a pg_export_snapshot() value');
  }
  if (input.relations.length === 0) {
    throw new RangeError('no relations to back up: the registry query returned nothing');
  }
  const seen = new Set<string>();
  const main: string[] = [];
  const personal: string[] = [];
  const unclassified: string[] = [];
  for (const { relation, backupClass: registered } of input.relations) {
    if (!RELATION_RE.test(relation)) {
      // Fail closed: a name that cannot be expressed as a safe pattern cannot be excluded
      // from the main set with certainty, so nothing is dumped at all.
      throw new RangeError(
        `relation ${JSON.stringify(relation)} is not a plain identifier; refusing to plan`,
      );
    }
    if (seen.has(relation)) throw new RangeError(`relation ${relation} listed twice`);
    seen.add(relation);
    const backupClass = registered ?? TOOLING_RELATION_CLASS[relation] ?? null;
    if (backupClass === 'main') main.push(relation);
    else {
      personal.push(relation);
      if (backupClass === null) unclassified.push(relation);
    }
  }
  main.sort();
  personal.sort();
  unclassified.sort();

  const snapshotArg = `--snapshot=${input.snapshotId}`;
  const keysFor = (set: BackupSet): BackupObjectKey[] =>
    tiersFor(set, input.takenAtMs, policy).map((tier) =>
      backupObjectKey(set, tier, input.takenAtMs),
    );

  const artifacts: PlannedArtifact[] = [
    {
      set: 'main',
      keys: keysFor('main'),
      pgDumpArgs: [
        ...PG_DUMP_BASE_ARGS,
        snapshotArg,
        ...personal.map((name) => `--exclude-table-data=public.${name}`),
      ],
      tablesWithData: main,
      minBytes: MIN_MAIN_ARTIFACT_BYTES,
    },
  ];
  if (personal.length > 0) {
    artifacts.push({
      set: 'personal',
      keys: keysFor('personal'),
      pgDumpArgs: [
        ...PG_DUMP_BASE_ARGS,
        snapshotArg,
        '--data-only',
        ...personal.map((name) => `--table=public.${name}`),
      ],
      tablesWithData: personal,
      minBytes: MIN_PERSONAL_ARTIFACT_BYTES,
    });
  }
  return { takenAtMs: input.takenAtMs, snapshotId: input.snapshotId, artifacts, unclassified };
}
