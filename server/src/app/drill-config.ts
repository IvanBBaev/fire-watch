/**
 * Arguments, environment and the production guard for the two drill CLIs (TASKS I7, J2;
 * OPERATIONS §6.3). In its own module so the tests can exercise it without importing an
 * entrypoint whose top level runs `main()`.
 *
 * Erasure drill (`erasure-drill-cli.ts`):
 *
 *   --environment=<name>       required; names the record (`staging`, `drill-laptop`)
 *   --audit-backups            also list `fw-personal/` and audit it (the restore side's
 *                              read credential: FIRE_WATCH_RESTORE_R2_… or _LOCAL_DIR, and
 *                              FIRE_WATCH_RESTORE_AGE_IDENTITY, as `restore-cli.ts` reads)
 *   --record-dir=<dir>         where the record goes (default `docs/drills/records/`)
 *   --confirm-not-production   run against a target that does not name itself
 *                              non-production (a laptop's Postgres); the record says so
 *
 *   DATABASE_URL               the database to seed and erase
 *   FIRE_WATCH_DB_ROLE         the role the eraser assumes (default `fire_watch_app`), so
 *                              the drill proves the runtime role's grants suffice
 *
 * Restore drill (`restore-drill-cli.ts`), on top of the backup and restore configuration
 * `backup-config.ts` reads:
 *
 *   --environment, --record-dir, --confirm-not-production   as above
 *   --database=<name>          the scratch database (default `fw_restore_drill_<stamp>`)
 *   --main-only                the §6.2 rule-8 leg
 *   --restore-only             skip the backup; restore what the bucket holds
 *   --key=<main key>           with --restore-only only: the artifact to restore
 *   --manual-step=<id>:<min>   repeatable: operator-reported minutes of a manual RTO step
 *
 * The guard is `assessDrillTarget`: the database or the bucket must carry a
 * non-production marker and none may carry a production one. `--confirm-not-production`
 * overrides the first half only — a target that *names* itself production is refused
 * whatever the flag says.
 */

import {
  assessDrillTarget,
  PRODUCTION_MARKERS,
  tokensOf,
  type DrillTargetInput,
} from '../core/drills/drill-target.js';
import { parseManualStep } from '../core/drills/rto.js';
import { scratchDatabaseProblem } from '../core/backup/restore-verify.js';
import { isoFromEpochMs, type EpochMs } from '../core/ports/clock.js';
import type { BackupStoreConfig } from './backup-config.js';
import { ConfigError, type Environment } from './config.js';

export const DEFAULT_DRILL_DB_ROLE = 'fire_watch_app';

const ERASURE_USAGE =
  'usage: erasure-drill --environment=<name> [--audit-backups] [--record-dir=<dir>] [--confirm-not-production]';
const RESTORE_USAGE =
  'usage: restore-drill --environment=<name> [--database=<scratch>] [--main-only] [--restore-only [--key=<main key>]] [--manual-step=<id>:<minutes>]… [--record-dir=<dir>] [--confirm-not-production]';

export interface DrillCommonArgs {
  readonly environment: string;
  readonly recordDir: string | null;
  readonly confirmNotProduction: boolean;
}

export interface ErasureDrillArgs extends DrillCommonArgs {
  readonly auditBackups: boolean;
}

export interface RestoreDrillArgs extends DrillCommonArgs {
  readonly database: string;
  readonly mainOnly: boolean;
  readonly restoreOnly: boolean;
  readonly key: string | null;
  readonly manualMinutes: Readonly<Record<string, number>>;
}

export interface ErasureDrillEnv {
  /** Carries the password: passed, never printed. */
  readonly databaseUrl: string;
  readonly role: string;
}

export interface GuardedTarget {
  /** Credential-free labels for the record. */
  readonly target: Readonly<Record<string, string>>;
  /** Set when `--confirm-not-production` overrode the check; the record carries it. */
  readonly override: string | null;
}

export function parseErasureDrillArgs(argv: readonly string[]): ErasureDrillArgs {
  let auditBackups = false;
  const common = parseCommon(argv, ERASURE_USAGE, (arg) => {
    if (arg === '--audit-backups') {
      auditBackups = true;
      return true;
    }
    return false;
  });
  return { ...common, auditBackups };
}

/** `nowMs` names the default scratch database; it is a parameter, never a clock read. */
export function parseRestoreDrillArgs(argv: readonly string[], nowMs: EpochMs): RestoreDrillArgs {
  let database: string | null = null;
  let mainOnly = false;
  let restoreOnly = false;
  let key: string | null = null;
  const manualMinutes: Record<string, number> = {};
  const common = parseCommon(argv, RESTORE_USAGE, (arg) => {
    if (arg === '--main-only') mainOnly = true;
    else if (arg === '--restore-only') restoreOnly = true;
    else if (arg.startsWith('--database=')) database = arg.slice('--database='.length);
    else if (arg.startsWith('--key=')) key = arg.slice('--key='.length);
    else if (arg.startsWith('--manual-step=')) {
      try {
        const report = parseManualStep(arg.slice('--manual-step='.length));
        if (report.id in manualMinutes) {
          throw new ConfigError(`--manual-step ${report.id} given twice; ${RESTORE_USAGE}`);
        }
        manualMinutes[report.id] = report.minutes;
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        throw new ConfigError(`${error instanceof Error ? error.message : String(error)}`);
      }
    } else return false;
    return true;
  });

  const name = database ?? defaultScratchDatabase(nowMs);
  const problem = scratchDatabaseProblem(name);
  if (problem !== null) throw new ConfigError(`--database ${JSON.stringify(name)} ${problem}`);
  if (key !== null) {
    if (key === '') throw new ConfigError(`--key must not be empty; ${RESTORE_USAGE}`);
    if (!restoreOnly) {
      throw new ConfigError(
        '--key needs --restore-only: a full drill restores the backup it just took',
      );
    }
  }
  return { ...common, database: name, mainOnly, restoreOnly, key, manualMinutes };
}

/** `fw_restore_drill_202609251015`: sortable, and a scratch name by construction. */
export function defaultScratchDatabase(nowMs: EpochMs): string {
  const digits = isoFromEpochMs(nowMs).replace(/\D/g, '').slice(0, 12);
  return `fw_restore_drill_${digits}`;
}

export function loadErasureDrillEnv(env: Environment): ErasureDrillEnv {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new ConfigError('DATABASE_URL is required');
  }
  const role = env['FIRE_WATCH_DB_ROLE'] ?? DEFAULT_DRILL_DB_ROLE;
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new ConfigError('FIRE_WATCH_DB_ROLE must be a lowercase unquoted identifier');
  }
  return { databaseUrl, role };
}

/** The bucket, or the local store directory, as the target guard reads it. */
export function storeLabel(store: BackupStoreConfig): string {
  return store.kind === 'r2' ? store.bucket : store.directory;
}

/**
 * Refuses a production-looking target with a {@link ConfigError}. The override lifts only
 * the "no non-production marker" refusal: a production marker is never overridable.
 */
export function guardDrillTarget(
  input: DrillTargetInput,
  confirmNotProduction: boolean,
): GuardedTarget {
  const assessment = assessDrillTarget(input);
  if (assessment.ok) return { target: assessment.described, override: null };
  const named = [
    input.databaseUrl === undefined || input.databaseUrl === null
      ? null
      : hostAndName(input.databaseUrl),
    input.databaseName,
    input.bucket,
  ]
    .filter((value): value is string => typeof value === 'string')
    .flatMap(tokensOf);
  const production = named.some((token) =>
    (PRODUCTION_MARKERS as readonly string[]).includes(token),
  );
  const why = assessment.problems.join('; ');
  if (production || !confirmNotProduction) {
    throw new ConfigError(
      production
        ? `refusing a production target: ${why}`
        : `refusing a target that does not name itself non-production: ${why}; pass --confirm-not-production if it is not production`,
    );
  }
  return {
    target: assessment.described,
    override: `--confirm-not-production overrode: ${why}`,
  };
}

/** Host and database name only: never the credentials a URL may carry. */
function hostAndName(databaseUrl: string): string | null {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname} ${decodeURIComponent(url.pathname.replace(/^\//, ''))}`;
  } catch {
    return null;
  }
}

function parseCommon(
  argv: readonly string[],
  usage: string,
  own: (arg: string) => boolean,
): DrillCommonArgs {
  let environment: string | null = null;
  let recordDir: string | null = null;
  let confirmNotProduction = false;
  for (const arg of argv) {
    if (arg === '--confirm-not-production') confirmNotProduction = true;
    else if (arg.startsWith('--environment=')) environment = arg.slice('--environment='.length);
    else if (arg.startsWith('--record-dir=')) recordDir = arg.slice('--record-dir='.length);
    else if (!own(arg)) throw new ConfigError(`unknown argument ${JSON.stringify(arg)}; ${usage}`);
  }
  if (environment === null || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(environment)) {
    throw new ConfigError(
      `--environment is required: lower-case letters, digits and dashes; ${usage}`,
    );
  }
  if (recordDir === '') throw new ConfigError(`--record-dir must not be empty; ${usage}`);
  return { environment, recordDir, confirmNotProduction };
}
