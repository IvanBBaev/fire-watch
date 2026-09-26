/**
 * Backup retention as data, and the checks that keep it inside the erasure promise
 * (TASKS C6, J2; OPERATIONS §6.2 rules 4, 5, 9; ADR-004 D8 / A1.3; I4).
 *
 * Who deletes: **R2 lifecycle rules**, never this job. The VM's backup token is
 * write-only (§8.1), so a compromised VM cannot destroy the backups — and so the job
 * cannot enforce retention either. This module therefore produces three things, all
 * pure:
 *
 *   1. {@link BACKUP_RETENTION} — the policy, per set and tier, in days.
 *   2. {@link lifecycleRules} — the bucket lifecycle rules that enforce it, derived from
 *      the policy so the two cannot drift. They are applied out-of-band by the operator.
 *   3. {@link planRetention} — given what a listing of the bucket returned, which objects
 *      the policy says should already be gone. It is the drill's retention leg (§6.3
 *      rule 7) and an audit of the lifecycle rules; it never deletes anything itself.
 *
 * The erasure horizon (30 days) binds the personal set only: rule 5 keeps personal rows
 * out of the main set by construction. {@link assessRetention} checks the policy against
 * `ERASURE_HORIZON` — including the non-current-version tail, which is where an "expired"
 * object quietly outlives its retention in a versioned bucket (rule 9).
 *
 * A **monthly tier** is not specified anywhere in OPERATIONS. It ships `null` (unarmed)
 * for both sets: no monthly key is written, no rule is emitted. Arming it for the main
 * set is a founder decision; arming it for the personal set is refused by
 * {@link assessRetention}, since any month-long tier breaks the 30-day horizon.
 */

import { ERASURE_HORIZON, type ErasureHorizon } from '../erasure/erasure-horizon.js';
import type { EpochMs } from '../ports/clock.js';
import {
  BACKUP_SETS,
  parseBackupObjectKey,
  tierPrefix,
  type BackupSet,
  type BackupTierName,
} from './backup-keys.js';

const DAY_MS = 86_400_000;

export interface SetRetention {
  /** Days a daily artifact is kept. */
  readonly dailyDays: number;
  /** Days a weekly (Sunday) artifact is kept, or null: the set writes no weeklies. */
  readonly weeklyDays: number | null;
  /** Days a monthly artifact is kept, or null: unarmed (see the module comment). */
  readonly monthlyDays: number | null;
}

export interface BackupRetentionPolicy {
  readonly sets: Readonly<Record<BackupSet, SetRetention>>;
  /**
   * Days a non-current object version survives after its expiry (rule 9). The erasure
   * check adds this to every personal retention: an expired-but-versioned object is still
   * a copy of the rows.
   */
  readonly noncurrentVersionDays: number;
  readonly spec: string;
}

export const BACKUP_RETENTION: BackupRetentionPolicy = {
  sets: {
    // §6.2 rule 4: 14 daily + 8 weekly.
    main: { dailyDays: 14, weeklyDays: 56, monthlyDays: null },
    // §6.2 rule 5: 28 daily, no weeklies — inside the 30-day horizon with a 2-day margin.
    personal: { dailyDays: 28, weeklyDays: null, monthlyDays: null },
  },
  noncurrentVersionDays: 1,
  spec: 'OPERATIONS §6.2 rules 4, 5, 9; ADR-004 D8 / A1.3',
};

/** The tiers a set writes tonight, in key order. Weeklies are Sunday's artifact, twice. */
export function tiersFor(
  set: BackupSet,
  takenAtMs: EpochMs,
  policy: BackupRetentionPolicy = BACKUP_RETENTION,
): BackupTierName[] {
  const retention = policy.sets[set];
  const date = new Date(takenAtMs);
  const tiers: BackupTierName[] = ['daily'];
  if (retention.weeklyDays !== null && date.getUTCDay() === 0) tiers.push('weekly');
  if (retention.monthlyDays !== null && date.getUTCDate() === 1) tiers.push('monthly');
  return tiers;
}

export function retentionDays(retention: SetRetention, tier: BackupTierName): number | null {
  if (tier === 'daily') return retention.dailyDays;
  if (tier === 'weekly') return retention.weeklyDays;
  return retention.monthlyDays;
}

export type RetentionFindingCode =
  'personal_set_exceeds_horizon' | 'set_exceeds_ratified_tier' | 'invalid_retention';

export interface RetentionFinding {
  readonly set: BackupSet | '*';
  readonly code: RetentionFindingCode;
  readonly detail: string;
}

export interface RetentionAssessment {
  readonly ok: boolean;
  /** The longest a personal row can survive in a backup: retention + non-current tail. */
  readonly personalWorstCaseDays: number;
  readonly horizonDays: number;
  readonly findings: readonly RetentionFinding[];
}

/**
 * The policy against the erasure horizon and against the tiers `ERASURE_HORIZON`
 * ratified. Fails closed: any finding makes `ok` false, and the backup CLI refuses to run
 * on a policy that is not ok.
 */
export function assessRetention(
  policy: BackupRetentionPolicy = BACKUP_RETENTION,
  horizon: ErasureHorizon = ERASURE_HORIZON,
): RetentionAssessment {
  const findings: RetentionFinding[] = [];
  const valid = (days: number | null): boolean =>
    days === null || (Number.isInteger(days) && days > 0);
  if (!Number.isInteger(policy.noncurrentVersionDays) || policy.noncurrentVersionDays < 0) {
    findings.push({
      set: '*',
      code: 'invalid_retention',
      detail: 'the non-current version tail must be a whole number of days, 0 or more',
    });
  }

  let personalWorst = 0;
  for (const set of BACKUP_SETS) {
    const retention = policy.sets[set];
    const all = [retention.dailyDays, retention.weeklyDays, retention.monthlyDays];
    if (!all.every(valid)) {
      findings.push({
        set,
        code: 'invalid_retention',
        detail: 'every retention must be a positive whole number of days, or null',
      });
      continue;
    }
    const longest = Math.max(...all.map((days) => days ?? 0));
    const worst = longest + Math.max(0, policy.noncurrentVersionDays);
    const tierName = set === 'main' ? 'fw-main' : 'fw-personal';
    const ratified = horizon.backupTiers.find((tier) => tier.tier === tierName);
    if (ratified?.retentionDays != null && longest > ratified.retentionDays) {
      findings.push({
        set,
        code: 'set_exceeds_ratified_tier',
        detail: `keeps artifacts ${String(longest)} days; ${tierName} is ratified at ${String(ratified.retentionDays)}`,
      });
    }
    if (set === 'personal') {
      personalWorst = worst;
      if (worst > horizon.horizonDays) {
        findings.push({
          set,
          code: 'personal_set_exceeds_horizon',
          detail: `a personal row can survive ${String(worst)} days (retention + non-current tail), past the ${String(horizon.horizonDays)}-day horizon`,
        });
      }
    }
  }
  return {
    ok: findings.length === 0,
    personalWorstCaseDays: personalWorst,
    horizonDays: horizon.horizonDays,
    findings,
  };
}

export interface LifecycleRule {
  /** Stable, so re-applying the rules is idempotent. */
  readonly id: string;
  readonly prefix: string;
  readonly expireCurrentAfterDays: number;
  readonly expireNoncurrentAfterDays: number;
}

/** One rule per armed (set, tier). An unarmed tier emits nothing: nothing is written there. */
export function lifecycleRules(policy: BackupRetentionPolicy = BACKUP_RETENTION): LifecycleRule[] {
  const rules: LifecycleRule[] = [];
  for (const set of BACKUP_SETS) {
    for (const tier of ['daily', 'weekly', 'monthly'] as const) {
      const days = retentionDays(policy.sets[set], tier);
      if (days === null) continue;
      rules.push({
        id: `fire-watch-${set}-${tier}-${String(days)}d`,
        prefix: tierPrefix(set, tier),
        expireCurrentAfterDays: days,
        expireNoncurrentAfterDays: policy.noncurrentVersionDays,
      });
    }
  }
  return rules;
}

export interface ListedObject {
  readonly key: string;
  readonly lastModifiedMs: EpochMs | null;
  readonly sizeBytes: number | null;
}

export type RetentionVerdict =
  | { readonly key: string; readonly action: 'keep'; readonly ageDays: number }
  | {
      readonly key: string;
      readonly action: 'expire';
      readonly ageDays: number;
      readonly limitDays: number;
      /** A personal artifact past the erasure horizon: the promise is already broken. */
      readonly pastErasureHorizon: boolean;
    }
  | { readonly key: string; readonly action: 'unrecognized'; readonly reason: string };

export interface RetentionPlan {
  readonly verdicts: readonly RetentionVerdict[];
  readonly expireCount: number;
  readonly pastErasureHorizonCount: number;
  readonly unrecognizedCount: number;
  /** The oldest personal artifact's age, or null when there is none (§6.3 rule 7). */
  readonly oldestPersonalAgeDays: number | null;
}

/**
 * What the policy says about each listed object at `nowMs`. The age is measured from the
 * snapshot instant in the key, not from `LastModified`: a re-upload must not reset an
 * artifact's clock. An object in an unarmed tier, or not in our key layout at all, is
 * `unrecognized` — reported, never treated as expired, never silently ignored.
 */
export function planRetention(
  objects: readonly ListedObject[],
  nowMs: EpochMs,
  policy: BackupRetentionPolicy = BACKUP_RETENTION,
  horizon: ErasureHorizon = ERASURE_HORIZON,
): RetentionPlan {
  const verdicts: RetentionVerdict[] = [];
  let oldestPersonal: number | null = null;
  for (const object of [...objects].sort((a, b) => a.key.localeCompare(b.key))) {
    const parsed = parseBackupObjectKey(object.key);
    if (parsed === null) {
      verdicts.push({ key: object.key, action: 'unrecognized', reason: 'not a backup key' });
      continue;
    }
    const limit = retentionDays(policy.sets[parsed.set], parsed.tier);
    if (limit === null) {
      verdicts.push({
        key: object.key,
        action: 'unrecognized',
        reason: `the ${parsed.tier} tier is unarmed for the ${parsed.set} set`,
      });
      continue;
    }
    const ageDays = Math.floor((nowMs - parsed.takenAtMs) / DAY_MS);
    if (parsed.set === 'personal') {
      oldestPersonal = oldestPersonal === null ? ageDays : Math.max(oldestPersonal, ageDays);
    }
    if (ageDays < limit) {
      verdicts.push({ key: object.key, action: 'keep', ageDays });
    } else {
      verdicts.push({
        key: object.key,
        action: 'expire',
        ageDays,
        limitDays: limit,
        pastErasureHorizon: parsed.set === 'personal' && ageDays >= horizon.horizonDays,
      });
    }
  }
  let expireCount = 0;
  let pastHorizon = 0;
  let unrecognized = 0;
  for (const verdict of verdicts) {
    if (verdict.action === 'expire') {
      expireCount += 1;
      if (verdict.pastErasureHorizon) pastHorizon += 1;
    } else if (verdict.action === 'unrecognized') {
      unrecognized += 1;
    }
  }
  return {
    verdicts,
    expireCount,
    pastErasureHorizonCount: pastHorizon,
    unrecognizedCount: unrecognized,
    oldestPersonalAgeDays: oldestPersonal,
  };
}
