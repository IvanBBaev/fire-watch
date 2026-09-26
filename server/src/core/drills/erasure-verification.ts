/**
 * What the erasure drill checks, as pure functions over what it seeded and what it then
 * observed (TASKS I7; ADR-004 D8, A1.3, A1.9; OPERATIONS §6.2 rules 5, 7, 9; §6.3 rule 7).
 *
 * The drill seeds a synthetic account with a row in every table `ERASURE_PLAN` names,
 * erases it through the production eraser, and then looks at the live database with fresh
 * queries. This module decides, table by table, whether what it saw is what the plan
 * promises:
 *
 *   - `delete` tables hold no row the account can still be found by;
 *   - the outbox rows survive, pseudonymized, the open ones closed `cancelled_erasure`;
 *   - the account row is a tombstone; the ledger row exists with the 30-day deadline;
 *   - a new write for the erased account is refused (migration 010's triggers);
 *   - every personal table in `table_backup_class` is covered by the plan — a personal
 *     table the plan does not name is where an erased user's data would survive.
 *
 * The backup leg ({@link verifyBackupErasure}) cannot watch 30 days pass. It checks what
 * can be checked on the drill's day: the policy keeps personal artifacts inside the
 * horizon, every personal artifact that predates the erasure expires (retention plus the
 * non-current tail) by the erasure's deadline, and nothing in the bucket is already past
 * the horizon (§6.3 rule 7).
 *
 * A leg the drill could not exercise is `not_run`, never a pass: a table nobody seeded
 * proves nothing about its erasure.
 */

import { parseBackupObjectKey } from '../backup/backup-keys.js';
import {
  BACKUP_RETENTION,
  assessRetention,
  planRetention,
  retentionDays,
  type BackupRetentionPolicy,
  type ListedObject,
} from '../backup/retention.js';
import {
  ERASURE_HORIZON,
  assessBackupHorizon,
  erasureDeadline,
  type ErasureHorizon,
} from '../erasure/erasure-horizon.js';
import {
  ERASURE_PLAN,
  ERASURE_PLAN_VERSION,
  RETAINED_TEMPLATE_PARAM_KEYS,
  isCancelledByErasure,
  type TableErasureRule,
} from '../erasure/erasure-plan.js';
import type { ErasureOutcome } from '../erasure/erase-account.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { ErasureCounts } from '../ports/account-erasure-store.js';
import { check, type DrillCheck } from './drill-record.js';

const DAY_MS = 86_400_000;

/** Tables the drill seeds by `delete` rule, and the `ErasureCounts` field each one feeds. */
export const DELETED_TABLE_COUNTS = {
  alert_states: 'alertStates',
  alerts_shadow: 'shadowAlerts',
  alert_decision_log: 'decisionLog',
  alert_digest_log: 'digestLog',
  watch_zones: 'zones',
  channel_confirmations: 'channelConfirmations',
  channel_subscriptions: 'subscriptions',
  account_sessions: 'sessions',
  auth_link_requests: 'linkRequests',
} as const satisfies Record<string, keyof ErasureCounts>;

export type DeletedTable = keyof typeof DELETED_TABLE_COUNTS;

export interface SeededOutboxRow {
  readonly id: string;
  /** The status the drill left the row in before erasing. */
  readonly seededStatus: string;
}

export interface ErasureDrillSeed {
  readonly accountId: string;
  /** Synthetic, under `.invalid` (RFC 2606): never a deliverable address. */
  readonly email: string;
  readonly zoneIds: readonly string[];
  /** Rows seeded per `delete` table. */
  readonly rows: Readonly<Record<DeletedTable, number>>;
  readonly outbox: readonly SeededOutboxRow[];
  /**
   * Why a leg could not be seeded, by table (`alert_outbox` and `alert_decision_log` need
   * an existing fire event, `alerts_shadow` an existing shadow event; the drill never
   * invents either).
   */
  readonly unseeded: Readonly<Partial<Record<DeletedTable | 'alert_outbox', string>>>;
}

export interface ObservedOutboxRow {
  readonly id: string;
  readonly status: string;
  readonly watchZoneIdNull: boolean;
  readonly channelSubscriptionIdNull: boolean;
  readonly templateParamKeys: readonly string[];
  readonly pseudonymizedAtMs: EpochMs | null;
}

export interface ErasureDrillObservation {
  /** Rows still reachable by the account id, its zone ids or its address, per table. */
  readonly remaining: Readonly<Record<DeletedTable, number>>;
  readonly account: {
    readonly exists: boolean;
    readonly emailNull: boolean;
    readonly emailVerifiedNull: boolean;
    readonly deletedAtMs: EpochMs | null;
  };
  /** The `erasure_requests` row for the account's hash, or null when there is none. */
  readonly ledger: {
    readonly erasedAtMs: EpochMs;
    readonly deadlineAtMs: EpochMs;
    readonly planVersion: string;
    readonly counts: Readonly<Record<string, unknown>>;
  } | null;
  readonly outbox: readonly ObservedOutboxRow[];
  /** Null when the probe could not run; true when the write was refused. */
  readonly erasedWriteRefused: boolean | null;
  /** Tables `table_backup_class` classes `personal`. */
  readonly personalTables: readonly string[];
}

const SPEC_PLAN = 'ADR-004 D8; OPERATIONS §6.2 rule 5; erasure-plan.ts';
const SPEC_OUTBOX = 'ADR-004 A1.3, A1.9';
const SPEC_TOMBSTONE = 'migration 010';

/** The counts the eraser must report for this seed. */
export function expectedErasureCounts(seed: ErasureDrillSeed): ErasureCounts {
  return {
    outboxCancelled: seed.outbox.filter((row) => isCancelledByErasure(row.seededStatus)).length,
    outboxPseudonymized: seed.outbox.length,
    alertStates: seed.rows.alert_states,
    shadowAlerts: seed.rows.alerts_shadow,
    decisionLog: seed.rows.alert_decision_log,
    digestLog: seed.rows.alert_digest_log,
    zones: seed.rows.watch_zones,
    channelConfirmations: seed.rows.channel_confirmations,
    subscriptions: seed.rows.channel_subscriptions,
    sessions: seed.rows.account_sessions,
    linkRequests: seed.rows.auth_link_requests,
  };
}

export function verifyErasure(
  seed: ErasureDrillSeed,
  outcome: ErasureOutcome,
  observation: ErasureDrillObservation,
  plan: readonly TableErasureRule[] = ERASURE_PLAN,
  horizon: ErasureHorizon = ERASURE_HORIZON,
): DrillCheck[] {
  const checks: DrillCheck[] = [coverageCheck(observation.personalTables, plan)];

  if (outcome.status !== 'erased') {
    checks.push(
      check(
        'erasure_outcome',
        'The eraser reports the account erased',
        'fail',
        `outcome ${outcome.status}; a fresh drill account must erase`,
        SPEC_PLAN,
      ),
    );
  } else {
    const deadline = erasureDeadline(outcome.erasedAt, horizon);
    checks.push(
      check(
        'erasure_outcome',
        'The eraser reports the account erased, with the horizon deadline',
        outcome.deadline === deadline ? 'pass' : 'fail',
        `erased ${isoFromEpochMs(outcome.erasedAt)}, deadline ${isoFromEpochMs(outcome.deadline)} (expected ${isoFromEpochMs(deadline)}, +${String(horizon.horizonDays)} d)`,
        'ADR-004 D8 / A1.3',
      ),
    );
    const expected = expectedErasureCounts(seed);
    const diffs = countDiffs(expected, outcome.counts);
    checks.push(
      check(
        'erasure_counts',
        'The eraser counted exactly the seeded rows',
        diffs.length === 0 ? 'pass' : 'fail',
        diffs.length === 0 ? formatCounts(expected) : diffs.join('; '),
        SPEC_PLAN,
      ),
    );
  }

  for (const rule of plan) {
    checks.push(tableCheck(rule, seed, outcome, observation, horizon));
  }

  checks.push(
    check(
      'erased_write_refused',
      'A new write for the erased account is refused',
      observation.erasedWriteRefused === null
        ? 'not_run'
        : observation.erasedWriteRefused
          ? 'pass'
          : 'fail',
      observation.erasedWriteRefused === null
        ? 'the probe could not run'
        : observation.erasedWriteRefused
          ? 'INSERT into channel_subscriptions for the tombstone was refused (rolled back)'
          : 'INSERT into channel_subscriptions for the tombstone succeeded (rolled back)',
      SPEC_TOMBSTONE,
    ),
  );
  return checks;
}

function coverageCheck(
  personalTables: readonly string[],
  plan: readonly TableErasureRule[],
): DrillCheck {
  const covered = new Set(plan.map((rule) => rule.table));
  const uncovered = personalTables.filter((table) => !covered.has(table)).sort();
  if (personalTables.length === 0) {
    return check(
      'plan_covers_registry',
      'Every personal table in the registry is covered by the erasure plan',
      'fail',
      'table_backup_class lists no personal table',
      SPEC_PLAN,
    );
  }
  return check(
    'plan_covers_registry',
    'Every personal table in the registry is covered by the erasure plan',
    uncovered.length === 0 ? 'pass' : 'fail',
    uncovered.length === 0
      ? `${String(personalTables.length)} personal tables, all named by ${ERASURE_PLAN_VERSION}`
      : `personal tables the plan does not name: ${uncovered.join(', ')}`,
    SPEC_PLAN,
  );
}

function tableCheck(
  rule: TableErasureRule,
  seed: ErasureDrillSeed,
  outcome: ErasureOutcome,
  observation: ErasureDrillObservation,
  horizon: ErasureHorizon,
): DrillCheck {
  const id = `table_${rule.table}`;
  const title = `${rule.table}: ${rule.action}`;
  switch (rule.action) {
    case 'delete':
      return deleteCheck(rule, id, title, seed, observation);
    case 'pseudonymize':
      return outboxCheck(id, title, seed, observation);
    case 'tombstone':
      return tombstoneCheck(rule, id, title, outcome, observation);
    case 'record':
      return ledgerCheck(rule, id, title, outcome, observation, horizon);
  }
}

function deleteCheck(
  rule: TableErasureRule,
  id: string,
  title: string,
  seed: ErasureDrillSeed,
  observation: ErasureDrillObservation,
): DrillCheck {
  if (!(rule.table in DELETED_TABLE_COUNTS)) {
    return check(id, title, 'not_run', 'the drill does not seed this table', rule.spec);
  }
  const table = rule.table as DeletedTable;
  const seeded = seed.rows[table];
  const remaining = observation.remaining[table];
  if (seeded === 0) {
    return check(
      id,
      title,
      'not_run',
      `nothing seeded: ${seed.unseeded[table] ?? 'no reason recorded'}`,
      rule.spec,
    );
  }
  return check(
    id,
    title,
    remaining === 0 ? 'pass' : 'fail',
    `${String(seeded)} seeded, ${String(remaining)} remaining`,
    rule.spec,
  );
}

function outboxCheck(
  id: string,
  title: string,
  seed: ErasureDrillSeed,
  observation: ErasureDrillObservation,
): DrillCheck {
  if (seed.outbox.length === 0) {
    return check(
      id,
      title,
      'not_run',
      `nothing seeded: ${seed.unseeded.alert_outbox ?? 'no reason recorded'}`,
      SPEC_OUTBOX,
    );
  }
  const problems: string[] = [];
  const observed = new Map(observation.outbox.map((row) => [row.id, row]));
  for (const seeded of seed.outbox) {
    const row = observed.get(seeded.id);
    if (row === undefined) {
      problems.push(`${seeded.id.slice(0, 8)} is gone (the row must survive, pseudonymized)`);
      continue;
    }
    const expectedStatus = isCancelledByErasure(seeded.seededStatus)
      ? 'cancelled_erasure'
      : seeded.seededStatus;
    if (row.status !== expectedStatus) {
      problems.push(
        `${seeded.id.slice(0, 8)} ${seeded.seededStatus} → ${row.status}, expected ${expectedStatus}`,
      );
    }
    if (!row.watchZoneIdNull) problems.push(`${seeded.id.slice(0, 8)} still names its zone`);
    if (!row.channelSubscriptionIdNull) {
      problems.push(`${seeded.id.slice(0, 8)} still names its subscription`);
    }
    const kept = row.templateParamKeys.filter((key) => !RETAINED_TEMPLATE_PARAM_KEYS.includes(key));
    if (kept.length > 0) {
      problems.push(`${seeded.id.slice(0, 8)} keeps template params ${kept.join(', ')}`);
    }
    if (row.pseudonymizedAtMs === null)
      problems.push(`${seeded.id.slice(0, 8)} has no pseudonymized_at`);
  }
  const statuses = [...new Set(seed.outbox.map((row) => row.seededStatus))].sort().join(', ');
  return check(
    id,
    title,
    problems.length === 0 ? 'pass' : 'fail',
    problems.length === 0
      ? `${String(seed.outbox.length)} rows (seeded ${statuses}) survive pseudonymized; open ones cancelled_erasure`
      : problems.join('; '),
    SPEC_OUTBOX,
  );
}

function tombstoneCheck(
  rule: TableErasureRule,
  id: string,
  title: string,
  outcome: ErasureOutcome,
  observation: ErasureDrillObservation,
): DrillCheck {
  const account = observation.account;
  const problems: string[] = [];
  if (!account.exists) problems.push('the account row is gone (a tombstone must remain)');
  else {
    if (!account.emailNull) problems.push('email is not NULL');
    if (!account.emailVerifiedNull) problems.push('email_verified_at is not NULL');
    if (account.deletedAtMs === null) problems.push('deleted_at is not set');
    else if (outcome.status === 'erased' && account.deletedAtMs !== outcome.erasedAt) {
      problems.push(
        `deleted_at ${isoFromEpochMs(account.deletedAtMs)} differs from the erasure instant ${isoFromEpochMs(outcome.erasedAt)}`,
      );
    }
  }
  return check(
    id,
    title,
    problems.length === 0 ? 'pass' : 'fail',
    problems.length === 0
      ? 'email and email_verified_at NULL, deleted_at set'
      : problems.join('; '),
    rule.spec,
  );
}

function ledgerCheck(
  rule: TableErasureRule,
  id: string,
  title: string,
  outcome: ErasureOutcome,
  observation: ErasureDrillObservation,
  horizon: ErasureHorizon,
): DrillCheck {
  const ledger = observation.ledger;
  if (ledger === null) {
    return check(id, title, 'fail', 'no erasure_requests row for the account hash', rule.spec);
  }
  const problems: string[] = [];
  if (ledger.planVersion !== ERASURE_PLAN_VERSION) {
    problems.push(`plan_version ${ledger.planVersion}, expected ${ERASURE_PLAN_VERSION}`);
  }
  if (ledger.deadlineAtMs !== erasureDeadline(ledger.erasedAtMs, horizon)) {
    problems.push(`deadline_at is not erased_at + ${String(horizon.horizonDays)} d`);
  }
  if (outcome.status === 'erased') {
    if (ledger.erasedAtMs !== outcome.erasedAt) problems.push('erased_at differs from the outcome');
    const recorded = countDiffs(outcome.counts, ledger.counts);
    if (recorded.length > 0)
      problems.push(`counts differ from the outcome: ${recorded.join('; ')}`);
  }
  return check(
    id,
    title,
    problems.length === 0 ? 'pass' : 'fail',
    problems.length === 0
      ? `${ledger.planVersion}, deadline ${isoFromEpochMs(ledger.deadlineAtMs)}`
      : problems.join('; '),
    rule.spec,
  );
}

function countDiffs(
  expected: ErasureCounts,
  recorded: ErasureCounts | Readonly<Record<string, unknown>>,
): string[] {
  const actual: Readonly<Record<string, unknown>> = { ...recorded };
  const diffs: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) diffs.push(`${key} ${String(actual[key])} ≠ ${String(value)}`);
  }
  return diffs;
}

function formatCounts(counts: ErasureCounts): string {
  return Object.entries(counts)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}

export interface BackupErasureInput {
  readonly erasedAtMs: EpochMs;
  readonly nowMs: EpochMs;
  /** Every object under `fw-personal/`, or null when the drill had no store to list. */
  readonly personalListing: readonly ListedObject[] | null;
  readonly policy?: BackupRetentionPolicy;
  readonly horizon?: ErasureHorizon;
}

/**
 * The backup half of the erasure promise, as far as one day can show it. Returns three
 * checks: the policy, the pre-erasure artifacts' expiry, and the bucket's current state.
 */
export function verifyBackupErasure(input: BackupErasureInput): DrillCheck[] {
  const policy = input.policy ?? BACKUP_RETENTION;
  const horizon = input.horizon ?? ERASURE_HORIZON;
  const checks: DrillCheck[] = [];

  const retention = assessRetention(policy, horizon);
  const tiers = assessBackupHorizon(horizon);
  const policyProblems = [
    ...retention.findings.map((f) => `${f.set} ${f.code}: ${f.detail}`),
    ...tiers.findings.map((f) => `${f.tier} ${f.code}: ${f.detail}`),
  ];
  checks.push(
    check(
      'backup_policy_within_horizon',
      'Personal backup retention (plus the non-current tail) is inside the erasure horizon',
      policyProblems.length === 0 ? 'pass' : 'fail',
      policyProblems.length === 0
        ? `worst case ${String(retention.personalWorstCaseDays)} d ≤ ${String(horizon.horizonDays)} d`
        : policyProblems.join('; '),
      'OPERATIONS §6.2 rules 5, 9; ADR-004 D8',
    ),
  );

  if (input.personalListing === null) {
    const reason =
      'no backup store listed (run with --audit-backups and the restore read credential)';
    checks.push(
      check(
        'backup_artifacts_expire_by_deadline',
        'Every personal artifact taken before the erasure expires by its deadline',
        'not_run',
        reason,
        'ADR-004 A1.3; OPERATIONS §6.2 rule 9',
      ),
      check(
        'backup_bucket_inside_horizon',
        'No personal artifact in the bucket is past the horizon; the oldest is at most 28 days',
        'not_run',
        reason,
        'OPERATIONS §6.3 rule 7',
      ),
    );
    return checks;
  }

  const deadline = erasureDeadline(input.erasedAtMs, horizon);
  const late: string[] = [];
  let before = 0;
  for (const object of input.personalListing) {
    const parsed = parseBackupObjectKey(object.key);
    if (parsed?.set !== 'personal' || parsed.takenAtMs > input.erasedAtMs) continue;
    before += 1;
    const days = retentionDays(policy.sets.personal, parsed.tier);
    const goneBy =
      days === null ? null : parsed.takenAtMs + (days + policy.noncurrentVersionDays) * DAY_MS;
    if (goneBy === null || goneBy > deadline) late.push(object.key);
  }
  checks.push(
    check(
      'backup_artifacts_expire_by_deadline',
      'Every personal artifact taken before the erasure expires by its deadline',
      late.length === 0 ? 'pass' : 'fail',
      late.length === 0
        ? `${String(before)} pre-erasure personal artifact(s), all gone (retention + ${String(policy.noncurrentVersionDays)} d tail) by ${isoFromEpochMs(deadline)}`
        : `outlive the deadline: ${late.join(', ')}`,
      'ADR-004 A1.3; OPERATIONS §6.2 rule 9',
    ),
  );

  const plan = planRetention(input.personalListing, input.nowMs, policy, horizon);
  const limit = retentionDays(policy.sets.personal, 'daily');
  const oldest = plan.oldestPersonalAgeDays;
  const problems: string[] = [];
  if (plan.pastErasureHorizonCount > 0) {
    problems.push(
      `${String(plan.pastErasureHorizonCount)} artifact(s) past the ${String(horizon.horizonDays)}-day horizon`,
    );
  }
  if (oldest !== null && limit !== null && oldest > limit) {
    problems.push(
      `the oldest personal artifact is ${String(oldest)} d old (limit ${String(limit)} d)`,
    );
  }
  checks.push(
    check(
      'backup_bucket_inside_horizon',
      'No personal artifact in the bucket is past the horizon; the oldest is at most 28 days',
      problems.length === 0 ? 'pass' : 'fail',
      problems.length === 0
        ? `${String(input.personalListing.length)} listed, oldest ${oldest === null ? 'none' : `${String(oldest)} d`}, ${String(plan.expireCount)} due to expire`
        : problems.join('; '),
      'OPERATIONS §6.3 rule 7',
    ),
  );
  return checks;
}
