/**
 * The erasure horizon as data (TASKS I4; ADR-004 D8 as settled by A1.3; OPERATIONS §6.2).
 *
 * **The promise.** An erased account is gone from the live database at once — the erasure
 * transaction is synchronous — and from every artifact that can hold alert-path personal
 * data within **30 days** (A1.3: "any backup tier holding alert-path personal data is
 * capped at 30 days").
 *
 * **Where the 30 days go.** OPERATIONS §6.2 splits the nightly dump: the personal set
 * (`fw-personal/`) keeps 28 daily artifacts and no weeklies (rule 5), and from v1 the WAL
 * archive and its base backups are bound to the same 28 days (rule 9). The main set keeps
 * 14 daily + 8 weekly — 56 days — and is allowed to, because it carries personal tables'
 * DDL but not their rows, and the outbox only as the pseudonymized projection of rule 7.
 * Rule 5 states the 2-day gap between 28 and 30 as margin for a lifecycle sweep that runs
 * daily rather than to the minute; it is reported here, not asserted against a number the
 * docs do not give.
 *
 * {@link assessBackupHorizon} is the check the plan runs over these figures: a tier that
 * holds personal data longer than the horizon is a finding, never a silent pass. Nothing
 * here reads a clock or a bucket; the drill's retention leg (OPERATIONS §6.3 rule 7) is
 * what compares these figures with what R2 actually holds.
 */

const DAY_MS = 86_400_000;

export interface BackupTier {
  /** Stable name, as OPERATIONS §6.2 spells it. */
  readonly tier: string;
  /**
   * Whether the tier can hold a recipient's rows. Only these are bound by the horizon;
   * the main set is not, because rule 5 excludes personal rows from it by construction.
   */
  readonly holdsPersonalData: boolean;
  /** Retention in whole days, as ratified; null when no figure is ratified. */
  readonly retentionDays: number | null;
  /** From which milestone the tier exists (`wp7`, `v1`). */
  readonly from: string;
  readonly spec: string;
}

export interface ErasureHorizon {
  /** ADR-004 D8 / A1.3: erasure reaches every personal artifact within this many days. */
  readonly horizonDays: number;
  /** The live database is erased by one synchronous transaction: zero days. */
  readonly liveDatabaseDays: 0;
  readonly backupTiers: readonly BackupTier[];
  readonly spec: string;
}

export const ERASURE_HORIZON: ErasureHorizon = {
  horizonDays: 30,
  liveDatabaseDays: 0,
  backupTiers: [
    {
      tier: 'fw-personal',
      holdsPersonalData: true,
      retentionDays: 28,
      from: 'wp7',
      spec: 'OPERATIONS §6.2 rules 5 and 9: 28 daily, no weeklies; R2 lifecycle expires non-current versions too',
    },
    {
      tier: 'wal-pitr',
      holdsPersonalData: true,
      retentionDays: 28,
      from: 'v1',
      spec: 'OPERATIONS §6.2 rule 9: the WAL archive and base backups share the 28-day ceiling',
    },
    {
      tier: 'fw-main',
      holdsPersonalData: false,
      retentionDays: 56,
      from: 'wp7',
      spec: 'OPERATIONS §6.2 rules 4, 5 and 7: 14 daily + 8 weekly; personal rows excluded, outbox pseudonymized',
    },
  ],
  spec: 'ADR-004 D8, A1.3; OPERATIONS §6.2',
};

export type HorizonFindingCode =
  'personal_tier_exceeds_horizon' | 'personal_tier_retention_unratified' | 'invalid_retention';

export interface HorizonFinding {
  readonly tier: string;
  readonly code: HorizonFindingCode;
  readonly detail: string;
}

export interface HorizonAssessment {
  readonly ok: boolean;
  readonly horizonDays: number;
  /** The longest personal-tier retention, or null when none is ratified. */
  readonly longestPersonalRetentionDays: number | null;
  /** `horizonDays - longestPersonalRetentionDays`: the sweep margin rule 5 describes. */
  readonly marginDays: number | null;
  readonly findings: readonly HorizonFinding[];
}

/**
 * Checks every personal tier against the horizon. Fails closed: a personal tier with no
 * ratified retention is a finding, because "we do not know how long it keeps rows" cannot
 * be inside a 30-day promise.
 */
export function assessBackupHorizon(horizon: ErasureHorizon): HorizonAssessment {
  const findings: HorizonFinding[] = [];
  let longest: number | null = null;
  if (!Number.isInteger(horizon.horizonDays) || horizon.horizonDays <= 0) {
    findings.push({
      tier: '*',
      code: 'invalid_retention',
      detail: 'the horizon must be a positive whole number of days',
    });
  }
  for (const tier of horizon.backupTiers) {
    const days = tier.retentionDays;
    if (days !== null && (!Number.isInteger(days) || days <= 0)) {
      findings.push({
        tier: tier.tier,
        code: 'invalid_retention',
        detail: 'retention must be a positive whole number of days',
      });
      continue;
    }
    if (!tier.holdsPersonalData) continue;
    if (days === null) {
      findings.push({
        tier: tier.tier,
        code: 'personal_tier_retention_unratified',
        detail: 'a tier holding personal data has no ratified retention',
      });
      continue;
    }
    longest = longest === null ? days : Math.max(longest, days);
    if (days > horizon.horizonDays) {
      findings.push({
        tier: tier.tier,
        code: 'personal_tier_exceeds_horizon',
        detail: `keeps personal rows ${String(days)} days, past the ${String(horizon.horizonDays)}-day horizon`,
      });
    }
  }
  return {
    ok: findings.length === 0,
    horizonDays: horizon.horizonDays,
    longestPersonalRetentionDays: longest,
    marginDays: longest === null ? null : horizon.horizonDays - longest,
    findings,
  };
}

/** The instant by which an erasure at `erasedAt` must have left every personal artifact. */
export function erasureDeadline(
  erasedAt: number,
  horizon: ErasureHorizon = ERASURE_HORIZON,
): number {
  return erasedAt + horizon.horizonDays * DAY_MS;
}
