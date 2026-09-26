/**
 * Did a restore produce the database we meant to back up? (TASKS C6; OPERATIONS §6.3.)
 *
 * The schema check is the one `infra/provision.sh --verify-only` performs, so a drill and
 * a provision agree on what "migrated" means: every local migration version
 * (`server/db/migrations/NNN_*.sql`, the prefix before the first `_`) must appear in
 * `schema_migrations`. A restored version the checkout does not know is reported too — the
 * artifact is newer than the code reading it — but only a missing one fails, as in
 * provision.sh.
 *
 * The personal check is rule 8 of §6.2: a main artifact restored **without** its personal
 * companion (the companion expired, or the drill's retention leg asks for exactly that)
 * must leave every personal table present and empty. A row there means personal data
 * travelled in the long-lived set.
 *
 * Pure: the applied versions, file names and counts arrive as arguments.
 */

import type { BackupClass } from './dump-plan.js';

export interface MigrationCheck {
  readonly ok: boolean;
  readonly applied: readonly string[];
  readonly local: readonly string[];
  /** Local versions the restored database lacks — the failure. */
  readonly missing: readonly string[];
  /** Restored versions with no local file: the artifact is newer than this checkout. */
  readonly unknown: readonly string[];
  /** The highest applied version, or null for an empty table. */
  readonly latestApplied: string | null;
}

/** `001_initial_schema.sql` → `001`; anything not `NNN_*.sql` is not a migration. */
export function migrationVersionOf(fileName: string): string | null {
  const match = /^(\d+)_[^/]*\.sql$/.exec(fileName);
  return match?.[1] ?? null;
}

export function checkMigrations(
  appliedVersions: readonly string[],
  localFileNames: readonly string[],
): MigrationCheck {
  const applied = [...new Set(appliedVersions.map((v) => v.trim()).filter((v) => v !== ''))].sort();
  const local = [
    ...new Set(localFileNames.map(migrationVersionOf).filter((v): v is string => v !== null)),
  ].sort();
  const appliedSet = new Set(applied);
  const localSet = new Set(local);
  const missing = local.filter((v) => !appliedSet.has(v));
  const unknown = applied.filter((v) => !localSet.has(v));
  return {
    // No local migrations is not a pass: provision.sh degrades to a weak check there, a
    // restore verifier has no reason to.
    ok: local.length > 0 && applied.length > 0 && missing.length === 0,
    applied,
    local,
    missing,
    unknown,
    latestApplied: applied.at(-1) ?? null,
  };
}

export interface RelationRowCount {
  readonly relation: string;
  readonly backupClass: BackupClass | null;
  readonly rows: number;
}

export interface PersonalRowsCheck {
  readonly ok: boolean;
  /** Whether the personal companion was restored; when it was, rows are expected. */
  readonly personalRestored: boolean;
  /** Personal (or unclassified) relations holding rows when none were restored. */
  readonly leaked: readonly string[];
  readonly personalRows: number;
  readonly mainRows: number;
}

export function checkPersonalRows(
  counts: readonly RelationRowCount[],
  personalRestored: boolean,
): PersonalRowsCheck {
  let personalRows = 0;
  let mainRows = 0;
  const leaked: string[] = [];
  for (const count of counts) {
    if (count.backupClass === 'main') {
      mainRows += count.rows;
      continue;
    }
    personalRows += count.rows;
    if (!personalRestored && count.rows > 0) leaked.push(count.relation);
  }
  leaked.sort();
  return { ok: leaked.length === 0, personalRestored, leaked, personalRows, mainRows };
}

/** Names that are never a scratch target: production and the cluster's own databases. */
export const FORBIDDEN_SCRATCH_DATABASES = [
  'fire_watch',
  'postgres',
  'template0',
  'template1',
] as const;

/**
 * A scratch database name: a plain identifier, never production's, and marked as scratch
 * in its name so a mistyped target cannot be a real database by accident.
 */
export function scratchDatabaseProblem(name: string): string | null {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    return 'must be a lower-case identifier (letters, digits, underscore; 63 chars max)';
  }
  if ((FORBIDDEN_SCRATCH_DATABASES as readonly string[]).includes(name)) {
    return 'names a production or system database';
  }
  if (!/(^|_)(scratch|restore|drill)(_|$)/.test(name)) {
    return "must contain 'scratch', 'restore' or 'drill' as a word, e.g. fw_restore_drill";
  }
  return null;
}
