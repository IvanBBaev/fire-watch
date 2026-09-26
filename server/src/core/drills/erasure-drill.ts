/**
 * The erasure drill as one sequence (TASKS I7; ADR-004 D8, A1.3, A1.9; OPERATIONS §6.2
 * rules 5, 7, 9; §6.3 rule 7).
 *
 *   1. Seed a synthetic account (`drill-…@example.invalid`) with a row in every table the
 *      erasure plan names.
 *   2. Erase it through the production eraser — the same function `DELETE /api/account`
 *      runs.
 *   3. Observe the live database with fresh queries, and probe that a new write for the
 *      erased account is refused.
 *   4. Audit the backup store's personal artifacts against the erasure's deadline (when a
 *      store was given).
 *
 * The legs arrive as functions, so the drill runs in a unit test against fakes. A leg that
 * throws ends the drill with the step failed and the error as a finding; the checks that
 * leg would have fed are `not_run`, and the record is written either way.
 */

import type { ListedObject } from '../backup/retention.js';
import type { ErasureOutcome } from '../erasure/erase-account.js';
import { ERASURE_PLAN_VERSION } from '../erasure/erasure-plan.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../ports/clock.js';
import {
  check,
  createStepRecorder,
  messageOf,
  type DrillCheck,
  type DrillRecord,
  type DrillStepDefinition,
} from './drill-record.js';
import {
  verifyBackupErasure,
  verifyErasure,
  type ErasureDrillObservation,
  type ErasureDrillSeed,
} from './erasure-verification.js';

export const ERASURE_DRILL_STEPS = {
  seed: {
    id: 'seed_account',
    title: 'Seed a synthetic account with a row in every table the plan names',
    mode: 'automated',
    onRtoPath: false,
  },
  erase: {
    id: 'erase_account',
    title: 'Erase it through the production eraser (DELETE /api/account path)',
    mode: 'automated',
    onRtoPath: false,
  },
  observe: {
    id: 'observe_live_database',
    title: 'Re-read every table and probe a write for the erased account',
    mode: 'automated',
    onRtoPath: false,
  },
  audit: {
    id: 'audit_backup_retention',
    title: 'List personal backup artifacts and check each expires by the deadline',
    mode: 'automated',
    onRtoPath: false,
  },
} as const satisfies Record<string, DrillStepDefinition>;

export interface ErasureDrillDeps {
  readonly clock: Clock;
  readonly seed: () => Promise<ErasureDrillSeed>;
  readonly erase: (accountId: string, atMs: EpochMs) => Promise<ErasureOutcome>;
  readonly observe: (seed: ErasureDrillSeed) => Promise<ErasureDrillObservation>;
  /** Every object under `fw-personal/`; null when no store is configured. */
  readonly listPersonalBackups: (() => Promise<readonly ListedObject[]>) | null;
}

export interface ErasureDrillOptions {
  readonly environment: string;
  readonly target: Readonly<Record<string, string>>;
  readonly targetOverride: string | null;
}

const OPEN_ITEMS = [
  'The drill leaves the tombstone, the erasure_requests row and the pseudonymized outbox rows behind: that is what an erasure leaves, by design.',
  'Seeded outbox rows are closed (cancelled_erasure) or already sent; a dispatcher running against this database never delivers them (the address is .invalid either way).',
  'Backup artifacts cannot be watched expiring in one day: the audit proves each pre-erasure personal artifact is due to go by the deadline; re-list after the deadline to close the loop.',
] as const;

export async function runErasureDrill(
  options: ErasureDrillOptions,
  deps: ErasureDrillDeps,
): Promise<DrillRecord> {
  const startedMs = deps.clock.now();
  const steps = createStepRecorder(deps.clock);
  const findings: string[] = [];
  const facts: Record<string, string> = { plan_version: ERASURE_PLAN_VERSION };
  if (options.targetOverride !== null) facts['target_check'] = options.targetOverride;
  const checks: DrillCheck[] = [];

  let seed: ErasureDrillSeed | null = null;
  let outcome: ErasureOutcome | null = null;
  let observation: ErasureDrillObservation | null = null;
  try {
    seed = await steps.run(ERASURE_DRILL_STEPS.seed, deps.seed, describeSeed);
    const seeded = seed;
    facts['account_id'] = seeded.accountId;
    facts['email'] = seeded.email;
    for (const [table, reason] of Object.entries(seeded.unseeded)) {
      findings.push(`${table} not seeded: ${reason}`);
    }
    const erasedAt = deps.clock.now();
    outcome = await steps.run(
      ERASURE_DRILL_STEPS.erase,
      () => deps.erase(seeded.accountId, erasedAt),
      (result) => result.status,
    );
    if (outcome.status === 'erased') {
      facts['erased_at'] = isoFromEpochMs(outcome.erasedAt);
      facts['deadline'] = isoFromEpochMs(outcome.deadline);
    }
    observation = await steps.run(
      ERASURE_DRILL_STEPS.observe,
      () => deps.observe(seeded),
      (o) => `${String(o.personalTables.length)} personal tables in the registry`,
    );
  } catch (error) {
    findings.push(`erasure drill stopped: ${messageOf(error)}`);
  }

  if (seed !== null && outcome !== null && observation !== null) {
    checks.push(...verifyErasure(seed, outcome, observation));
  } else {
    checks.push(
      check(
        'erasure_verified',
        'The seeded account was erased and every table verified',
        'not_run',
        'the drill stopped before the live database was observed',
        'ADR-004 D8',
      ),
    );
  }

  const erasedAtMs = outcome?.status === 'erased' ? outcome.erasedAt : null;
  let listing: readonly ListedObject[] | null = null;
  if (deps.listPersonalBackups === null) {
    steps.skip(ERASURE_DRILL_STEPS.audit, 'no backup store configured (--audit-backups)');
  } else if (erasedAtMs === null) {
    steps.skip(ERASURE_DRILL_STEPS.audit, 'nothing was erased');
  } else {
    const list = deps.listPersonalBackups;
    try {
      listing = await steps.run(
        ERASURE_DRILL_STEPS.audit,
        list,
        (objects) => `${String(objects.length)} personal object(s) listed`,
      );
    } catch (error) {
      findings.push(`backup listing failed: ${messageOf(error)}`);
    }
  }
  checks.push(
    ...verifyBackupErasure({
      erasedAtMs: erasedAtMs ?? startedMs,
      nowMs: deps.clock.now(),
      personalListing: listing,
    }),
  );

  return {
    kind: 'erasure',
    environment: options.environment,
    target: options.target,
    startedAt: isoFromEpochMs(startedMs),
    finishedAt: isoFromEpochMs(deps.clock.now()),
    steps: steps.steps(),
    checks,
    rto: null,
    facts,
    findings,
    openItems: [...OPEN_ITEMS],
  };
}

function describeSeed(seed: ErasureDrillSeed): string {
  const rows = Object.entries(seed.rows)
    .map(([table, count]) => `${table}=${String(count)}`)
    .join(', ');
  return `${rows}, alert_outbox=${String(seed.outbox.length)}`;
}
