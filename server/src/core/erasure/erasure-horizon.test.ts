import { describe, expect, it } from 'vitest';

import {
  assessBackupHorizon,
  ERASURE_HORIZON,
  erasureDeadline,
  type ErasureHorizon,
} from './erasure-horizon.js';

const DAY_MS = 86_400_000;

function withTiers(tiers: ErasureHorizon['backupTiers'], horizonDays = 30): ErasureHorizon {
  return { ...ERASURE_HORIZON, horizonDays, backupTiers: tiers };
}

describe('the shipped horizon', () => {
  it('holds: every personal tier is inside 30 days, with the 2-day sweep margin', () => {
    expect(assessBackupHorizon(ERASURE_HORIZON)).toEqual({
      ok: true,
      horizonDays: 30,
      longestPersonalRetentionDays: 28,
      marginDays: 2,
      findings: [],
    });
  });

  it('binds the personal set and the WAL archive, and not the main set', () => {
    const personal = ERASURE_HORIZON.backupTiers.filter((tier) => tier.holdsPersonalData);
    expect(personal.map((tier) => tier.tier)).toEqual(['fw-personal', 'wal-pitr']);
    const main = ERASURE_HORIZON.backupTiers.find((tier) => tier.tier === 'fw-main');
    expect(main).toMatchObject({ holdsPersonalData: false, retentionDays: 56 });
  });

  it('erases the live database synchronously', () => {
    expect(ERASURE_HORIZON.liveDatabaseDays).toBe(0);
  });
});

describe('assessBackupHorizon', () => {
  const tier = (retentionDays: number | null, holdsPersonalData = true) => ({
    tier: 't',
    holdsPersonalData,
    retentionDays,
    from: 'wp7',
    spec: 'test',
  });

  it('flags a personal tier that keeps rows past the horizon', () => {
    const result = assessBackupHorizon(withTiers([tier(31)]));
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual(['personal_tier_exceeds_horizon']);
    expect(result.marginDays).toBe(-1);
  });

  it('accepts a personal tier exactly at the horizon', () => {
    expect(assessBackupHorizon(withTiers([tier(30)]))).toMatchObject({ ok: true, marginDays: 0 });
  });

  it('fails closed on a personal tier with no ratified retention', () => {
    const result = assessBackupHorizon(withTiers([tier(null)]));
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual(['personal_tier_retention_unratified']);
    expect(result.longestPersonalRetentionDays).toBeNull();
    expect(result.marginDays).toBeNull();
  });

  it('ignores a long non-personal tier and an unratified one', () => {
    expect(assessBackupHorizon(withTiers([tier(365, false), tier(null, false)])).ok).toBe(true);
  });

  it('refuses a fractional, zero or negative retention on any tier', () => {
    for (const days of [0, -3, 2.5]) {
      const result = assessBackupHorizon(withTiers([tier(days, false)]));
      expect(result.findings.map((f) => f.code)).toEqual(['invalid_retention']);
    }
  });

  it('refuses a horizon that is not a positive whole number of days', () => {
    const result = assessBackupHorizon(withTiers([], 0));
    expect(result.findings).toEqual([
      expect.objectContaining({ tier: '*', code: 'invalid_retention' }),
    ]);
  });
});

describe('erasureDeadline', () => {
  it('is the erasure instant plus the horizon', () => {
    const at = Date.parse('2026-09-23T10:00:00Z');
    expect(erasureDeadline(at)).toBe(at + 30 * DAY_MS);
    expect(new Date(erasureDeadline(at)).toISOString()).toBe('2026-10-23T10:00:00.000Z');
  });
});
