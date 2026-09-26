import { describe, expect, it } from 'vitest';

import { ERASURE_HORIZON } from '../erasure/erasure-horizon.js';
import { epochMsFromIso } from '../ports/clock.js';
import { backupObjectKey } from './backup-keys.js';
import {
  assessRetention,
  BACKUP_RETENTION,
  lifecycleRules,
  planRetention,
  retentionDays,
  tiersFor,
  type BackupRetentionPolicy,
  type ListedObject,
} from './retention.js';

const DAY = 86_400_000;
const THURSDAY = epochMsFromIso('2026-09-24T02:20:00Z');
const SUNDAY = epochMsFromIso('2026-09-20T02:20:00Z');
const FIRST = epochMsFromIso('2026-10-01T02:20:00Z');

function withSets(sets: Partial<BackupRetentionPolicy['sets']>, tail = 1): BackupRetentionPolicy {
  return {
    ...BACKUP_RETENTION,
    sets: { ...BACKUP_RETENTION.sets, ...sets },
    noncurrentVersionDays: tail,
  };
}

function listed(key: string): ListedObject {
  return { key, lastModifiedMs: null, sizeBytes: null };
}

describe('BACKUP_RETENTION', () => {
  it('is the ratified policy, and it passes its own assessment', () => {
    expect(BACKUP_RETENTION.sets.main).toEqual({
      dailyDays: 14,
      weeklyDays: 56,
      monthlyDays: null,
    });
    expect(BACKUP_RETENTION.sets.personal).toEqual({
      dailyDays: 28,
      weeklyDays: null,
      monthlyDays: null,
    });
    const assessment = assessRetention();
    expect(assessment).toEqual({
      ok: true,
      personalWorstCaseDays: 29,
      horizonDays: 30,
      findings: [],
    });
  });
});

describe('tiersFor', () => {
  it('writes daily only on a weekday', () => {
    expect(tiersFor('main', THURSDAY)).toEqual(['daily']);
    expect(tiersFor('personal', THURSDAY)).toEqual(['daily']);
  });

  it('adds weekly on a UTC Sunday for the main set only', () => {
    expect(tiersFor('main', SUNDAY)).toEqual(['daily', 'weekly']);
    expect(tiersFor('personal', SUNDAY)).toEqual(['daily']);
  });

  it('adds monthly on day 1 only when armed', () => {
    expect(tiersFor('main', FIRST)).toEqual(['daily']);
    const armed = withSets({ main: { dailyDays: 14, weeklyDays: 56, monthlyDays: 365 } });
    expect(tiersFor('main', FIRST, armed)).toEqual(['daily', 'monthly']);
  });
});

describe('retentionDays', () => {
  it('reads the tier', () => {
    const r = BACKUP_RETENTION.sets.main;
    expect(retentionDays(r, 'daily')).toBe(14);
    expect(retentionDays(r, 'weekly')).toBe(56);
    expect(retentionDays(r, 'monthly')).toBeNull();
  });
});

describe('assessRetention', () => {
  it('refuses a personal set that outlives the horizon, counting the non-current tail', () => {
    const atEdge = assessRetention(withSets({}, 2));
    expect(atEdge.ok).toBe(true);
    expect(atEdge.personalWorstCaseDays).toBe(30);

    const over = assessRetention(withSets({}, 3));
    expect(over.ok).toBe(false);
    expect(over.personalWorstCaseDays).toBe(31);
    expect(over.findings.map((f) => f.code)).toEqual(['personal_set_exceeds_horizon']);
  });

  it('refuses an armed personal monthly tier', () => {
    const result = assessRetention(
      withSets({ personal: { dailyDays: 28, weeklyDays: null, monthlyDays: 31 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.set, f.code])).toEqual(
      expect.arrayContaining([
        ['personal', 'personal_set_exceeds_horizon'],
        ['personal', 'set_exceeds_ratified_tier'],
      ]),
    );
  });

  it('refuses a main set kept longer than its ratified tier', () => {
    const result = assessRetention(
      withSets({ main: { dailyDays: 14, weeklyDays: 56, monthlyDays: 365 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ set: 'main', code: 'set_exceeds_ratified_tier' }),
    ]);
  });

  it('refuses nonsense retention values', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const result = assessRetention(
        withSets({ main: { dailyDays: bad, weeklyDays: 56, monthlyDays: null } }),
      );
      expect(result.ok).toBe(false);
      expect(result.findings[0]).toMatchObject({ set: 'main', code: 'invalid_retention' });
    }
    const tail = assessRetention(withSets({}, -1));
    expect(tail.ok).toBe(false);
    expect(tail.findings[0]).toMatchObject({ set: '*', code: 'invalid_retention' });
  });

  it('is measured against the horizon it is given', () => {
    const tighter = { ...ERASURE_HORIZON, horizonDays: 20 };
    expect(assessRetention(BACKUP_RETENTION, tighter).ok).toBe(false);
  });
});

describe('lifecycleRules', () => {
  it('emits one rule per armed tier, with the non-current tail', () => {
    expect(lifecycleRules()).toEqual([
      {
        id: 'fire-watch-main-daily-14d',
        prefix: 'fw-main/daily/',
        expireCurrentAfterDays: 14,
        expireNoncurrentAfterDays: 1,
      },
      {
        id: 'fire-watch-main-weekly-56d',
        prefix: 'fw-main/weekly/',
        expireCurrentAfterDays: 56,
        expireNoncurrentAfterDays: 1,
      },
      {
        id: 'fire-watch-personal-daily-28d',
        prefix: 'fw-personal/daily/',
        expireCurrentAfterDays: 28,
        expireNoncurrentAfterDays: 1,
      },
    ]);
  });
});

describe('planRetention', () => {
  const now = THURSDAY;
  const key = (set: 'main' | 'personal', tier: 'daily' | 'weekly' | 'monthly', daysAgo: number) =>
    backupObjectKey(set, tier, now - daysAgo * DAY).key;

  it('keeps what is inside the policy and expires what is not', () => {
    const plan = planRetention(
      [
        listed(key('main', 'daily', 13)),
        listed(key('main', 'daily', 14)),
        listed(key('main', 'weekly', 55)),
        listed(key('personal', 'daily', 27)),
        listed(key('personal', 'daily', 28)),
      ],
      now,
    );
    const byKey = new Map(plan.verdicts.map((v) => [v.key, v]));
    expect(byKey.get(key('main', 'daily', 13))).toMatchObject({ action: 'keep', ageDays: 13 });
    expect(byKey.get(key('main', 'daily', 14))).toMatchObject({
      action: 'expire',
      limitDays: 14,
      pastErasureHorizon: false,
    });
    expect(byKey.get(key('main', 'weekly', 55))).toMatchObject({ action: 'keep' });
    expect(byKey.get(key('personal', 'daily', 27))).toMatchObject({ action: 'keep' });
    expect(byKey.get(key('personal', 'daily', 28))).toMatchObject({
      action: 'expire',
      pastErasureHorizon: false,
    });
    expect(plan.expireCount).toBe(2);
    expect(plan.pastErasureHorizonCount).toBe(0);
    expect(plan.oldestPersonalAgeDays).toBe(28);
  });

  it('flags a personal artifact past the erasure horizon, but not a main one', () => {
    const plan = planRetention(
      [listed(key('personal', 'daily', 30)), listed(key('main', 'weekly', 60))],
      now,
    );
    expect(plan.pastErasureHorizonCount).toBe(1);
    expect(plan.expireCount).toBe(2);
    const personal = plan.verdicts.find((v) => v.key.startsWith('fw-personal/'));
    expect(personal).toMatchObject({ action: 'expire', pastErasureHorizon: true, ageDays: 30 });
  });

  it('ages from the key timestamp, not LastModified', () => {
    const k = key('personal', 'daily', 29);
    const plan = planRetention([{ key: k, lastModifiedMs: now, sizeBytes: 10 }], now);
    expect(plan.verdicts[0]).toMatchObject({ action: 'expire', ageDays: 29 });
  });

  it('reports foreign keys and unarmed tiers as unrecognized, never as expired', () => {
    const plan = planRetention(
      [listed('fw-main/daily/readme.txt'), listed(key('main', 'monthly', 400))],
      now,
    );
    expect(plan.unrecognizedCount).toBe(2);
    expect(plan.expireCount).toBe(0);
    expect(plan.verdicts.map((v) => v.action)).toEqual(['unrecognized', 'unrecognized']);
    expect(plan.oldestPersonalAgeDays).toBeNull();
  });

  it('is order-independent', () => {
    const objects = [listed(key('main', 'daily', 1)), listed(key('personal', 'daily', 2))];
    expect(planRetention(objects, now)).toEqual(planRetention([...objects].reverse(), now));
  });
});
