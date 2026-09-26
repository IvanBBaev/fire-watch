/**
 * The backup/restore + RTO drill as one sequence (TASKS J2; OPERATIONS §6.3; GATES L-17;
 * runbook 02 M2/M3).
 *
 *   1. Take a backup now (the production job, `runBackup`), so the drill restores an
 *      artifact whose dump-time gauges it holds — or, `--restore-only`, skip it and restore
 *      what the bucket has.
 *   2. The manual RTO steps the operator reports (`--manual-step=id:minutes`).
 *   3. Restore that artifact into a new scratch database (`runRestore`), timed.
 *   4. Check: the artifact restored is the one just taken; migrations are present; the
 *      companion came back (or was skipped on `--main-only`); personal tables hold rows
 *      only with the companion (§6.2 rule 8); every table's rows equal the dump-time gauge
 *      (§6.3 rule 3); the bucket holds no personal artifact past the horizon (rule 7).
 *   5. Evaluate the RTO over the path.
 *
 * Nothing here touches a process or a bucket: the two legs arrive as functions, so the
 * whole drill runs in a unit test against fakes. A leg that throws ends the drill with the
 * step marked failed and the error as a finding — the record is written either way.
 */

import { parseBackupObjectKey } from '../backup/backup-keys.js';
import type { BackupRunSummary } from '../backup/backup-run.js';
import type { RestoreTarget } from '../backup/ports.js';
import type { RestoreRunSummary } from '../backup/restore-run.js';
import type { RelationRowCount } from '../backup/restore-verify.js';
import { BACKUP_RETENTION, retentionDays } from '../backup/retention.js';
import { isoFromEpochMs, type Clock } from '../ports/clock.js';
import {
  check,
  createStepRecorder,
  messageOf,
  type DrillCheck,
  type DrillRecord,
  type DrillStepDefinition,
} from './drill-record.js';
import { compareRestoredRows } from './restore-verification.js';
import { evaluateRto, RTO_PATH_STEPS } from './rto.js';

export const TAKE_BACKUP_STEP: DrillStepDefinition = {
  id: 'take_backup',
  title: 'Take a backup now with the production job (before the simulated loss)',
  mode: 'automated',
  onRtoPath: false,
};

export interface RestoreLegResult {
  readonly summary: RestoreRunSummary;
  /** What the restore target counted, or null when it never got that far. */
  readonly restoredCounts: readonly RelationRowCount[] | null;
}

export interface RestoreDrillDeps {
  readonly clock: Clock;
  /** Null on `--restore-only`. */
  readonly backup: (() => Promise<BackupRunSummary>) | null;
  /** Restores `mainKey`, or the newest main artifact when null. */
  readonly restore: (mainKey: string | null) => Promise<RestoreLegResult>;
}

export interface RestoreDrillOptions {
  readonly environment: string;
  readonly target: Readonly<Record<string, string>>;
  readonly database: string;
  readonly mainOnly: boolean;
  /** `--key`, restore-only drills only. */
  readonly requestedKey: string | null;
  /** Minutes the operator reported per manual step id. */
  readonly manualMinutes: Readonly<Record<string, number>>;
  /** Set when `--confirm-not-production` overrode the target check. */
  readonly targetOverride: string | null;
}

const OPEN_ITEMS = [
  'The scratch database is left in place: drop it after reading this record (docs/drills/README.md).',
  'Manual steps are operator-reported minutes, not measured; a step not reported leaves the RTO a lower bound.',
  'A --main-only run is the §6.2 rule-8 leg (main alone carries no personal row); run it at least once per drill cycle.',
] as const;

export async function runRestoreDrill(
  options: RestoreDrillOptions,
  deps: RestoreDrillDeps,
): Promise<DrillRecord> {
  const startedMs = deps.clock.now();
  const steps = createStepRecorder(deps.clock);
  const findings: string[] = [];
  const facts: Record<string, string> = { scratch_database: options.database };
  if (options.targetOverride !== null) facts['target_check'] = options.targetOverride;

  let backup: BackupRunSummary | null = null;
  let backupFailed = false;
  if (deps.backup === null) {
    steps.skip(TAKE_BACKUP_STEP, '--restore-only: restoring what the bucket holds');
  } else {
    const takeBackup = deps.backup;
    try {
      backup = await steps.run(TAKE_BACKUP_STEP, takeBackup, (summary) =>
        summary.uploaded.map((u) => `${u.set} ${String(u.bytes)} B`).join(', '),
      );
    } catch (error) {
      backupFailed = true;
      findings.push(`backup failed: ${messageOf(error)}`);
    }
  }
  const drillKey = backup === null ? null : dailyMainKey(backup);
  if (backup !== null) {
    facts['backup_taken_at'] = backup.takenAt;
    if (drillKey !== null) facts['backup_main_key'] = drillKey;
    if (backup.plan.unclassified.length > 0) {
      findings.push(
        `tables missing from the backup registry: ${backup.plan.unclassified.join(', ')}`,
      );
    }
    if (backup.tableGauges !== null && backup.tableGauges.unplanned.length > 0) {
      findings.push(`tables no artifact carries: ${backup.tableGauges.unplanned.join(', ')}`);
    }
  }

  const { provisionVm, deployStack, restoreSecrets, restoreDatabase, promoteAndBoot, flipOrigin } =
    RTO_PATH_STEPS;
  for (const step of [provisionVm, deployStack, restoreSecrets]) {
    steps.manual(step, options.manualMinutes[step.id] ?? null);
  }

  let restore: RestoreLegResult | null = null;
  if (backupFailed) {
    steps.skip(restoreDatabase, 'the backup failed');
  } else if (deps.backup !== null && drillKey === null) {
    steps.skip(restoreDatabase, 'the backup uploaded no daily main artifact');
    findings.push('the backup uploaded no daily main artifact');
  } else {
    const key = drillKey ?? options.requestedKey;
    try {
      restore = await steps.run(
        restoreDatabase,
        () => deps.restore(key),
        (result) => `${result.summary.mainKey} → ${result.summary.database}`,
      );
    } catch (error) {
      findings.push(`restore failed: ${messageOf(error)}`);
    }
  }
  for (const step of [promoteAndBoot, flipOrigin]) {
    steps.manual(step, options.manualMinutes[step.id] ?? null);
  }

  const checks = restoreChecks(options, backup, drillKey, restore, deps.backup === null);
  if (restore !== null) {
    const summary = restore.summary;
    facts['restored_main_key'] = summary.mainKey;
    facts['artifact_taken_at'] = summary.takenAt;
    facts['artifact_age_days'] = String(summary.artifactAgeDays);
    facts['companion'] = `${summary.companion.status} (${summary.companion.key})`;
    facts['latest_migration'] = summary.migrations.latestApplied ?? 'none';
    facts['main_rows'] = String(summary.personalRows.mainRows);
    facts['personal_rows'] = String(summary.personalRows.personalRows);
    findings.push(...summary.findings);
  }

  const recorded = steps.steps();
  return {
    kind: 'restore',
    environment: options.environment,
    target: options.target,
    startedAt: isoFromEpochMs(startedMs),
    finishedAt: isoFromEpochMs(deps.clock.now()),
    steps: recorded,
    checks,
    rto: evaluateRto(recorded),
    facts,
    findings,
    openItems: [...OPEN_ITEMS],
  };
}

function restoreChecks(
  options: RestoreDrillOptions,
  backup: BackupRunSummary | null,
  drillKey: string | null,
  restore: RestoreLegResult | null,
  restoreOnly: boolean,
): DrillCheck[] {
  const checks: DrillCheck[] = [];
  if (restoreOnly) {
    checks.push(
      check(
        'backup_uploaded',
        'The drill backup uploaded both sets',
        'not_run',
        '--restore-only',
        'OPERATIONS §6.2',
      ),
    );
  } else {
    const sets = backup?.uploaded.map((u) => u.set) ?? [];
    const both = sets.includes('main') && sets.includes('personal');
    checks.push(
      check(
        'backup_uploaded',
        'The drill backup uploaded both sets',
        backup === null ? 'fail' : both ? 'pass' : 'fail',
        backup === null
          ? 'the backup did not complete'
          : `uploaded: ${sets.join(', ') || 'nothing'}`,
        'OPERATIONS §6.2 rule 5',
      ),
    );
  }

  if (restore === null) {
    const detail = 'the restore did not complete';
    for (const [id, title, spec] of RESTORE_CHECKS)
      checks.push(check(id, title, 'not_run', detail, spec));
    checks.push(compareRestoredRows(null, null, false).check);
    return checks;
  }
  const summary = restore.summary;

  checks.push(
    check(
      'restored_drill_artifact',
      'The restore picked the artifact the drill just took',
      drillKey === null ? 'not_run' : summary.mainKey === drillKey ? 'pass' : 'fail',
      drillKey === null
        ? `restore-only: restored ${summary.mainKey}`
        : `expected ${drillKey}, restored ${summary.mainKey}`,
      'OPERATIONS §6.3 rule 3',
    ),
  );
  checks.push(
    check(
      'migrations_present',
      'Every migration of this checkout is applied in the restored database',
      summary.migrations.ok ? 'pass' : 'fail',
      summary.migrations.ok
        ? `latest ${summary.migrations.latestApplied ?? 'none'}${summary.migrations.unknown.length > 0 ? `; newer than the checkout: ${summary.migrations.unknown.join(', ')}` : ''}`
        : `missing: ${summary.migrations.missing.join(', ') || 'no applied or no local migrations'}`,
      'OPERATIONS §6.3 rule 3; infra/provision.sh --verify-only',
    ),
  );
  checks.push(companionCheck(options, summary, restoreOnly));
  checks.push(
    check(
      'personal_rows_only_with_companion',
      'Personal tables hold rows only when the companion was restored',
      summary.personalRows.ok ? 'pass' : 'fail',
      summary.personalRows.ok
        ? `${String(summary.personalRows.personalRows)} personal rows, companion ${summary.companion.status}`
        : `leaked: ${summary.personalRows.leaked.join(', ')}`,
      'OPERATIONS §6.2 rule 8',
    ),
  );
  const limit = retentionDays(BACKUP_RETENTION.sets.personal, 'daily');
  const oldest = summary.retention.oldestPersonalAgeDays;
  const retentionOk =
    summary.retention.pastErasureHorizonCount === 0 &&
    (oldest === null || limit === null || oldest <= limit);
  checks.push(
    check(
      'retention_leg',
      'No personal artifact past the horizon; the oldest is at most 28 days',
      retentionOk ? 'pass' : 'fail',
      `${String(summary.retention.listed)} listed, oldest personal ${oldest === null ? 'none' : `${String(oldest)} d`}, ${String(summary.retention.pastErasureHorizonCount)} past the horizon, ${String(summary.retention.unrecognizedCount)} unrecognized`,
      'OPERATIONS §6.3 rule 7',
    ),
  );
  checks.push(
    check(
      'restore_verified',
      'The restore verified clean (restore_summary ok)',
      summary.ok ? 'pass' : 'fail',
      summary.ok ? 'no findings' : summary.findings.join('; '),
      'runbook 02 M3',
    ),
  );
  checks.push(
    compareRestoredRows(
      backup?.tableGauges?.gauges ?? null,
      restore.restoredCounts,
      summary.companion.status === 'restored',
    ).check,
  );
  return checks;
}

const RESTORE_CHECKS: readonly (readonly [string, string, string])[] = [
  [
    'restored_drill_artifact',
    'The restore picked the artifact the drill just took',
    'OPERATIONS §6.3 rule 3',
  ],
  [
    'migrations_present',
    'Every migration of this checkout is applied in the restored database',
    'OPERATIONS §6.3 rule 3',
  ],
  [
    'companion',
    'The personal companion was restored (or deliberately skipped)',
    'OPERATIONS §6.2 rule 5',
  ],
  [
    'personal_rows_only_with_companion',
    'Personal tables hold rows only when the companion was restored',
    'OPERATIONS §6.2 rule 8',
  ],
  [
    'retention_leg',
    'No personal artifact past the horizon; the oldest is at most 28 days',
    'OPERATIONS §6.3 rule 7',
  ],
  ['restore_verified', 'The restore verified clean (restore_summary ok)', 'runbook 02 M3'],
];

function companionCheck(
  options: RestoreDrillOptions,
  summary: RestoreRunSummary,
  restoreOnly: boolean,
): DrillCheck {
  const status = summary.companion.status;
  let ok: boolean;
  let expected: string;
  if (options.mainOnly) {
    ok = status === 'skipped';
    expected = 'skipped (--main-only)';
  } else if (restoreOnly) {
    // An older artifact's companion may legitimately be past retention; never restored then.
    ok = status === 'restored' || status === 'expired';
    expected = 'restored, or expired for an artifact past the personal retention';
  } else {
    ok = status === 'restored';
    expected = "restored (the drill's own night)";
  }
  return check(
    'companion',
    'The personal companion was restored (or deliberately skipped)',
    ok ? 'pass' : 'fail',
    `${status}; expected ${expected}`,
    'OPERATIONS §6.2 rules 5, 8',
  );
}

/** The daily main key the backup uploaded: the key a restore of tonight names. */
export function dailyMainKey(summary: BackupRunSummary): string | null {
  for (const artifact of summary.uploaded) {
    if (artifact.set !== 'main') continue;
    for (const key of artifact.keys) {
      if (parseBackupObjectKey(key)?.tier === 'daily') return key;
    }
  }
  return null;
}

/**
 * Wraps a restore target so the drill sees the row counts the restore itself read, instead
 * of counting a second time (and possibly seeing a different database).
 */
export function captureRowCounts(target: RestoreTarget): {
  readonly target: RestoreTarget;
  counts(): readonly RelationRowCount[] | null;
} {
  let captured: readonly RelationRowCount[] | null = null;
  return {
    target: {
      createDatabase: (name) => target.createDatabase(name),
      restore: (input) => target.restore(input),
      appliedMigrations: (database) => target.appliedMigrations(database),
      async rowCounts(database) {
        const counts = await target.rowCounts(database);
        captured = counts;
        return counts;
      },
    },
    counts: () => captured,
  };
}
