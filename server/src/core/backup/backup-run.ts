/**
 * One nightly backup run, orchestrated over ports (TASKS C6; OPERATIONS §6.2, §1.3, §3).
 *
 *   1. Refuse a retention policy that breaks the erasure horizon (fail-closed, J2).
 *   2. Read the registry; export one snapshot; dump both sets from it, encrypted, to disk.
 *   3. Release the snapshot — before the uploads, so a slow network does not hold a
 *      transaction open on the production database.
 *   4. Upload every key of every artifact (a Sunday's artifact twice: daily + weekly).
 *   5. Prune local staging; ping `nightly-backup` **after** the last upload succeeded.
 *
 * While the snapshot is held, per-table row and byte gauges are read from it and emitted,
 * with a comparison against the previous night's (`table-gauges.ts`). The gauges are
 * best-effort: a failure to read them is reported and the backup carries on — an unmeasured
 * backup is still a backup, a skipped one is not. They become the next night's baseline
 * only once every upload landed.
 *
 * Any failure pings `/fail` from the catch — the failure path, not a `finally` (§3 rule 5)
 * — and rethrows, so the process exits non-zero and systemd's `OnFailure=` fires too. The
 * clock is read once, after the snapshot is exported: the key instant is the data instant.
 *
 * A dry run reads the registry and plans, and does nothing else: no snapshot, no dump, no
 * upload, no ping.
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import type { Clock } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import { artifactFileName } from './backup-keys.js';
import { planBackupRun, type BackupRunPlan } from './dump-plan.js';
import type {
  ArtifactProducer,
  BackupDatabase,
  BackupObjectWriter,
  BackupPinger,
  StagedArtifact,
  TableGaugeLedger,
} from './ports.js';
import { assessRetention, BACKUP_RETENTION, type BackupRetentionPolicy } from './retention.js';
import {
  backupTableGauges,
  compareTableGauges,
  type TableGauges,
  type TableShrinkage,
} from './table-gauges.js';

export interface BackupRunDeps {
  readonly database: BackupDatabase;
  readonly producer: ArtifactProducer;
  readonly writer: BackupObjectWriter;
  readonly pinger: BackupPinger;
  /** Where the previous night's gauges are kept; without one, no comparison is made. */
  readonly gaugeLedger?: TableGaugeLedger;
  readonly clock: Clock;
  /** Progress lines, already canonical JSON. */
  readonly writeLine: (line: string) => void;
}

export interface BackupRunOptions {
  readonly dryRun: boolean;
  /**
   * Keep tonight's main artifact in local staging (1) or not (0) — the shell job's
   * BACKUP_KEEP_LOCAL, bounded to one copy: older staged files are always pruned.
   */
  readonly keepLocalMain: 0 | 1;
  readonly policy?: BackupRetentionPolicy;
}

export interface UploadedArtifact {
  readonly set: string;
  readonly keys: readonly string[];
  readonly bytes: number;
  readonly sha256: string;
}

export interface BackupRunSummary {
  readonly mode: 'dry_run' | 'backup';
  readonly takenAt: string;
  readonly plan: BackupRunPlan;
  readonly uploaded: readonly UploadedArtifact[];
  /** Null on a dry run, or when the gauges could not be read. */
  readonly tableGauges: TableGauges | null;
  /** Null without a previous night to compare with. */
  readonly shrinkage: TableShrinkage | null;
}

/** Placeholder id for a dry run's plan: no snapshot is exported. */
export const DRY_RUN_SNAPSHOT_ID = '00000000-00000000-0';

export async function runBackup(
  options: BackupRunOptions,
  deps: BackupRunDeps,
): Promise<BackupRunSummary> {
  const policy = options.policy ?? BACKUP_RETENTION;
  const emit = (record: Record<string, unknown>): void => {
    deps.writeLine(canonicalJson({ backup: record }));
  };

  const staged: { set: string; keys: string[]; artifact: StagedArtifact }[] = [];
  try {
    const assessment = assessRetention(policy);
    if (!assessment.ok) {
      throw new Error(
        `retention policy refused: ${assessment.findings.map((f) => `${f.set} ${f.code}`).join('; ')}`,
      );
    }

    const relations = await deps.database.classifiedRelations();
    const migrations = await deps.database.appliedMigrations();
    const migrationVersion = [...migrations].sort().at(-1) ?? 'none';

    if (options.dryRun) {
      const takenAtMs = deps.clock.now();
      const plan = planBackupRun({
        relations,
        snapshotId: DRY_RUN_SNAPSHOT_ID,
        takenAtMs,
        policy,
      });
      reportPlan(emit, plan, migrationVersion);
      return {
        mode: 'dry_run',
        takenAt: isoFromEpochMs(takenAtMs),
        plan,
        uploaded: [],
        tableGauges: null,
        shrinkage: null,
      };
    }

    const lease = await deps.database.exportSnapshot();
    const takenAtMs = Math.floor(deps.clock.now() / 1000) * 1000;
    let plan: BackupRunPlan;
    let gauges: TableGauges | null;
    let shrinkage: TableShrinkage | null;
    try {
      plan = planBackupRun({ relations, snapshotId: lease.snapshotId, takenAtMs, policy });
      reportPlan(emit, plan, migrationVersion);
      ({ gauges, shrinkage } = await measureTables(emit, deps, lease.snapshotId, plan));
      for (const planned of plan.artifacts) {
        const artifact = await deps.producer.dumpEncrypted({
          fileName: artifactFileName(planned.set, takenAtMs),
          pgDumpArgs: planned.pgDumpArgs,
        });
        if (artifact.bytes < planned.minBytes) {
          throw new Error(
            `${planned.set} artifact is ${String(artifact.bytes)} bytes, under the ${String(planned.minBytes)}-byte floor; refusing to upload`,
          );
        }
        emit({ dumped: { set: planned.set, bytes: artifact.bytes, sha256: artifact.sha256 } });
        staged.push({ set: planned.set, keys: planned.keys.map((k) => k.key), artifact });
      }
    } finally {
      // Releasing the transaction is cleanup, not a signal: it belongs in a finally. The
      // ping does not (see the module comment).
      await lease.release();
    }

    const takenAt = isoFromEpochMs(takenAtMs);
    const uploaded: UploadedArtifact[] = [];
    for (const { set, keys, artifact } of staged) {
      for (const key of keys) {
        const { etag } = await deps.writer.upload(key, artifact, {
          'backup-set': set,
          'taken-at': takenAt,
          sha256: artifact.sha256,
          'migration-version': migrationVersion,
          format: 'pg-dump-custom+age',
        });
        emit({ uploaded: { key, bytes: artifact.bytes, etag } });
      }
      uploaded.push({ set, keys, bytes: artifact.bytes, sha256: artifact.sha256 });
    }

    // The personal set is never kept locally: a staging copy has no lifecycle rule, and a
    // stalled job would otherwise keep a copy of personal rows past the horizon.
    const keep = staged
      .filter(({ set }) => set === 'main')
      .slice(0, options.keepLocalMain)
      .map(({ artifact }) => artifact.path);
    await deps.producer.pruneStaging(keep);

    if (gauges !== null && deps.gaugeLedger !== undefined) {
      await deps.gaugeLedger.write({ takenAt, gauges: gauges.gauges }).catch((error: unknown) => {
        emit({ table_gauges_ledger: { error: messageOf(error) } });
      });
    }

    // ---- success path only (§3 rule 5) ----
    await deps.pinger.succeeded();
    emit({ done: { taken_at: takenAt, artifacts: uploaded.length } });
    return { mode: 'backup', takenAt, plan, uploaded, tableGauges: gauges, shrinkage };
  } catch (error) {
    if (!options.dryRun) {
      // A failed night must not leave a personal dump behind on disk either. Best effort:
      // the failure being reported is the one that matters.
      const mainOnly = staged
        .filter(({ set }) => set === 'main')
        .map(({ artifact }) => artifact.path);
      await deps.producer.pruneStaging(mainOnly).catch(() => undefined);
      await deps.pinger.failed();
    }
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads, emits and compares the per-table gauges. Never throws: see the module comment. */
async function measureTables(
  emit: (record: Record<string, unknown>) => void,
  deps: BackupRunDeps,
  snapshotId: string,
  plan: BackupRunPlan,
): Promise<{ gauges: TableGauges | null; shrinkage: TableShrinkage | null }> {
  let gauges: TableGauges;
  try {
    gauges = backupTableGauges(await deps.database.tableStats(snapshotId), plan);
  } catch (error) {
    emit({ table_gauges: { error: messageOf(error) } });
    return { gauges: null, shrinkage: null };
  }
  emit({
    table_gauges: {
      gauges: gauges.gauges.map((g) => ({
        relation: g.relation,
        set: g.set,
        rows: g.rows,
        bytes: g.bytes,
      })),
      unplanned: gauges.unplanned,
    },
  });

  if (deps.gaugeLedger === undefined) return { gauges, shrinkage: null };
  let shrinkage: TableShrinkage | null = null;
  try {
    const previous = await deps.gaugeLedger.read();
    if (previous !== null) shrinkage = compareTableGauges(previous, gauges.gauges);
  } catch (error) {
    emit({ table_gauges_ledger: { error: messageOf(error) } });
  }
  if (shrinkage !== null) {
    emit({
      table_shrinkage: {
        previous_taken_at: shrinkage.previousTakenAt,
        shrunk: shrinkage.shrunk.map((s) => ({
          relation: s.relation,
          set: s.set,
          previous_rows: s.previousRows,
          rows: s.rows,
        })),
        vanished: shrinkage.vanished,
      },
    });
  }
  return { gauges, shrinkage };
}

function reportPlan(
  emit: (record: Record<string, unknown>) => void,
  plan: BackupRunPlan,
  migrationVersion: string,
): void {
  emit({
    plan: {
      taken_at: isoFromEpochMs(plan.takenAtMs),
      migration_version: migrationVersion,
      artifacts: plan.artifacts.map((a) => ({
        set: a.set,
        keys: a.keys.map((k) => k.key),
        tables_with_data: a.tablesWithData.length,
      })),
      unclassified: plan.unclassified,
    },
  });
}
