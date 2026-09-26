/**
 * One restore of a nightly backup into a scratch database, orchestrated over ports
 * (TASKS C6, J2; OPERATIONS §6.2 rule 8, §6.3; runbook 02).
 *
 *   1. Refuse a target that is not unmistakably a scratch database.
 *   2. List the bucket; pick the main artifact (the one named, or the newest).
 *   3. Run the retention audit over the listing (§6.3 rule 7's retention leg): a personal
 *      artifact past the erasure horizon means the erasure promise is already broken.
 *   4. Decide the personal companion — same night, same snapshot — **erasure-aware**:
 *      a companion at or past the personal set's retention is never restored, even when
 *      the bucket still holds it (a lifecycle sweep that has not run yet). Restoring it
 *      would bring back accounts erased since, which is exactly what the 28-day personal
 *      tier exists to prevent. The main set alone restores with every personal table
 *      present and empty (§6.2 rule 8).
 *   5. Download and check every artifact's SHA-256 against the one the job recorded,
 *      before anything touches the database.
 *   6. Create the scratch database, restore main, then the companion if any.
 *   7. Verify: migrations (the provision.sh rule) and personal rows (rule 8).
 *
 * Downloads are discarded in a `finally`: a local copy of personal rows has no lifecycle
 * rule. The verdict is returned, not thrown — a restore that ran but failed a check is a
 * drill result the operator needs to read in full; the CLI turns `ok: false` into exit 1.
 *
 * Pure orchestration: every side effect is a port, the clock is read once.
 */

import { ERASURE_HORIZON, type ErasureHorizon } from '../erasure/erasure-horizon.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import type { Clock } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import {
  artifactFileName,
  backupObjectKey,
  parseBackupObjectKey,
  SET_PREFIX,
  type BackupObjectKey,
  type BackupSet,
} from './backup-keys.js';
import { TOOLING_RELATION_CLASS } from './dump-plan.js';
import type {
  BackupObjectReader,
  FetchedArtifact,
  RestoreTarget,
  RestoreWorkspace,
} from './ports.js';
import {
  checkMigrations,
  checkPersonalRows,
  scratchDatabaseProblem,
  type MigrationCheck,
  type PersonalRowsCheck,
} from './restore-verify.js';
import {
  BACKUP_RETENTION,
  planRetention,
  retentionDays,
  type BackupRetentionPolicy,
} from './retention.js';

const DAY_MS = 86_400_000;

/** The main set carries the schema: one transaction, stop at the first error. */
export const PG_RESTORE_MAIN_ARGS = ['--exit-on-error', '--single-transaction'] as const;
/** The personal set is rows only, into the tables main just created. */
export const PG_RESTORE_PERSONAL_ARGS = [
  '--exit-on-error',
  '--single-transaction',
  '--data-only',
] as const;

export interface RestoreRunOptions {
  /** The scratch database to create; see {@link scratchDatabaseProblem}. */
  readonly database: string;
  /** A main-set object key to restore, or null: the newest main artifact listed. */
  readonly mainKey: string | null;
  /** Restore main alone even when a companion is available — the drill's rule-8 leg. */
  readonly mainOnly: boolean;
  /** `server/db/migrations` file names of the checkout doing the restore. */
  readonly localMigrationFiles: readonly string[];
  readonly policy?: BackupRetentionPolicy;
  readonly horizon?: ErasureHorizon;
}

export interface RestoreRunDeps {
  readonly reader: BackupObjectReader;
  readonly target: RestoreTarget;
  readonly workspace: RestoreWorkspace;
  readonly clock: Clock;
  /** Progress lines, already canonical JSON. */
  readonly writeLine: (line: string) => void;
}

/**
 * - `restored` — downloaded, verified, restored.
 * - `skipped` — the operator asked for main alone.
 * - `expired` — at or past the personal retention: never restored (erasure-aware).
 * - `absent` — the bucket does not hold it (already swept, or the night had none).
 */
export type CompanionStatus = 'restored' | 'skipped' | 'expired' | 'absent';

export interface RetentionAudit {
  readonly listed: number;
  readonly expireCount: number;
  readonly pastErasureHorizonCount: number;
  readonly unrecognizedCount: number;
  readonly oldestPersonalAgeDays: number | null;
}

export interface RestoreRunSummary {
  readonly ok: boolean;
  readonly database: string;
  readonly mainKey: string;
  readonly takenAt: string;
  readonly artifactAgeDays: number;
  readonly companion: {
    readonly key: string;
    readonly status: CompanionStatus;
  };
  readonly migrations: MigrationCheck;
  readonly personalRows: PersonalRowsCheck;
  readonly retention: RetentionAudit;
  /** Why `ok` is false, one short line each; empty when ok. */
  readonly findings: readonly string[];
}

export async function runRestore(
  options: RestoreRunOptions,
  deps: RestoreRunDeps,
): Promise<RestoreRunSummary> {
  const policy = options.policy ?? BACKUP_RETENTION;
  const horizon = options.horizon ?? ERASURE_HORIZON;
  const emit = (record: Record<string, unknown>): void => {
    deps.writeLine(canonicalJson({ restore: record }));
  };

  const problem = scratchDatabaseProblem(options.database);
  if (problem !== null) {
    throw new Error(`refusing restore target ${JSON.stringify(options.database)}: ${problem}`);
  }

  const nowMs = deps.clock.now();
  const mainListing = await deps.reader.list(`${SET_PREFIX.main}/`);
  const personalListing = await deps.reader.list(`${SET_PREFIX.personal}/`);

  const main = selectMain(
    options.mainKey,
    mainListing.map((o) => o.key),
  );
  const audit = planRetention([...mainListing, ...personalListing], nowMs, policy, horizon);
  const retention: RetentionAudit = {
    listed: mainListing.length + personalListing.length,
    expireCount: audit.expireCount,
    pastErasureHorizonCount: audit.pastErasureHorizonCount,
    unrecognizedCount: audit.unrecognizedCount,
    oldestPersonalAgeDays: audit.oldestPersonalAgeDays,
  };

  const artifactAgeDays = Math.floor((nowMs - main.takenAtMs) / DAY_MS);
  // Personal artifacts are daily-only; a weekly main artifact's companion is the daily
  // personal artifact of the same snapshot.
  const companion = backupObjectKey('personal', 'daily', main.takenAtMs);
  const personalLimit = retentionDays(policy.sets.personal, 'daily');
  let status: CompanionStatus;
  if (options.mainOnly) status = 'skipped';
  else if (personalLimit === null || artifactAgeDays >= personalLimit) status = 'expired';
  else status = 'absent';

  emit({
    selected: {
      main_key: main.key,
      taken_at: isoFromEpochMs(main.takenAtMs),
      age_days: artifactAgeDays,
      companion_key: companion.key,
      companion: status,
      retention,
    },
  });

  const downloads: string[] = [];
  try {
    const mainArtifact = await fetchVerified(deps, main, downloads);
    if (mainArtifact === null) throw new Error(`main artifact ${main.key} does not exist`);
    let personalArtifact: FetchedArtifact | null = null;
    if (status === 'absent') {
      personalArtifact = await fetchVerified(deps, companion, downloads);
      if (personalArtifact !== null) status = 'restored';
    }

    await deps.target.createDatabase(options.database);
    await deps.target.restore({
      database: options.database,
      artifactPath: mainArtifact.path,
      pgRestoreArgs: PG_RESTORE_MAIN_ARGS,
    });
    emit({ restored: { set: 'main', key: main.key, bytes: mainArtifact.bytes } });
    if (personalArtifact !== null) {
      await deps.target.restore({
        database: options.database,
        artifactPath: personalArtifact.path,
        pgRestoreArgs: PG_RESTORE_PERSONAL_ARGS,
      });
      emit({ restored: { set: 'personal', key: companion.key, bytes: personalArtifact.bytes } });
    }

    const migrations = checkMigrations(
      await deps.target.appliedMigrations(options.database),
      options.localMigrationFiles,
    );
    const counts = (await deps.target.rowCounts(options.database)).map((count) => ({
      ...count,
      backupClass: count.backupClass ?? TOOLING_RELATION_CLASS[count.relation] ?? null,
    }));
    const personalRows = checkPersonalRows(counts, status === 'restored');

    const findings: string[] = [];
    if (!migrations.ok) {
      findings.push(
        migrations.missing.length > 0
          ? `migrations missing from the restore: ${migrations.missing.join(', ')}`
          : 'migration check failed: no applied or no local migrations',
      );
    }
    if (!personalRows.ok) {
      findings.push(
        `personal tables hold rows without their companion (§6.2 rule 8): ${personalRows.leaked.join(', ')}`,
      );
    }
    if (retention.pastErasureHorizonCount > 0) {
      findings.push(
        `${String(retention.pastErasureHorizonCount)} personal artifact(s) in the bucket are past the ${String(horizon.horizonDays)}-day erasure horizon`,
      );
    }

    const summary: RestoreRunSummary = {
      ok: findings.length === 0,
      database: options.database,
      mainKey: main.key,
      takenAt: isoFromEpochMs(main.takenAtMs),
      artifactAgeDays,
      companion: { key: companion.key, status },
      migrations,
      personalRows,
      retention,
      findings,
    };
    emit({
      verdict: {
        ok: summary.ok,
        database: summary.database,
        companion: status,
        latest_migration: migrations.latestApplied,
        migrations_missing: migrations.missing,
        migrations_unknown: migrations.unknown,
        personal_rows: personalRows.personalRows,
        main_rows: personalRows.mainRows,
        leaked: personalRows.leaked,
        findings,
      },
    });
    return summary;
  } finally {
    for (const path of downloads) {
      await deps.workspace.discard(path).catch(() => undefined);
    }
  }
}

/** The named main key, or the newest main artifact (daily preferred on a tie). */
export function selectMain(
  requested: string | null,
  listedKeys: readonly string[],
): BackupObjectKey {
  if (requested !== null) {
    const parsed = parseBackupObjectKey(requested);
    if (parsed?.set !== 'main') {
      throw new Error('the requested key is not a main-set backup key');
    }
    return parsed;
  }
  let best: BackupObjectKey | null = null;
  for (const key of listedKeys) {
    const parsed = parseBackupObjectKey(key);
    if (parsed?.set !== 'main') continue;
    if (
      best === null ||
      parsed.takenAtMs > best.takenAtMs ||
      (parsed.takenAtMs === best.takenAtMs && parsed.tier === 'daily')
    ) {
      best = parsed;
    }
  }
  if (best === null) throw new Error('no main-set backup artifact found in the bucket');
  return best;
}

async function fetchVerified(
  deps: RestoreRunDeps,
  key: BackupObjectKey,
  downloads: string[],
): Promise<FetchedArtifact | null> {
  const set: BackupSet = key.set;
  const path = deps.workspace.pathFor(artifactFileName(set, key.takenAtMs));
  // Registered before the download starts: a half-written file is discarded too.
  downloads.push(path);
  const fetched = await deps.reader.download(key.key, path);
  if (fetched === null) return null;
  if (fetched.recordedSha256 === null) {
    throw new Error(
      `${set} artifact ${key.key} carries no recorded sha256; refusing to restore it`,
    );
  }
  if (fetched.recordedSha256 !== fetched.sha256) {
    throw new Error(`${set} artifact ${key.key} does not match its recorded sha256`);
  }
  return fetched;
}
