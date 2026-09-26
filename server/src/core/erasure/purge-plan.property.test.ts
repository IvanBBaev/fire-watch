import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { retainedTemplateParams } from './erasure-plan.js';
import {
  planPurge,
  PURGE_TARGET_SPECS,
  PURGE_TARGETS,
  PurgeRetentionError,
  type PurgeRetention,
} from './purge-plan.js';

const DAY_MS = 86_400_000;
const START = epochMsFromIso('2026-01-01T00:00:00Z');

const retentionArb = fc.option(fc.integer({ min: -5, max: 400 }), { nil: null });
const retentionsArb = fc.record({
  erasure_ledger: retentionArb,
  expired_link_requests: retentionArb,
  ended_sessions: retentionArb,
  account_tombstones: retentionArb,
  alert_decision_log: retentionArb,
  alert_digest_log: retentionArb,
}) as fc.Arbitrary<PurgeRetention>;
const atArb = fc.integer({ min: 0, max: 3 * 365 }).map((days) => START + days * DAY_MS);

describe('planPurge, for any retention', () => {
  it('either refuses, or never cuts inside a floor and arms exactly the non-null targets', () => {
    fc.assert(
      fc.property(atArb, retentionsArb, (at, retention) => {
        let steps;
        try {
          steps = planPurge(at, retention);
        } catch (error) {
          expect(error).toBeInstanceOf(PurgeRetentionError);
          return;
        }
        expect(steps.map((step) => step.target)).toEqual([...PURGE_TARGETS]);
        for (const step of steps) {
          const days = retention[step.target];
          expect(step.armed).toBe(days !== null);
          if (!step.armed) continue;
          const cutoff = Date.parse(step.cutoffIso);
          expect(cutoff).toBeLessThanOrEqual(at - PURGE_TARGET_SPECS[step.target].floorMs);
          expect(at - cutoff).toBe(step.retentionDays * DAY_MS);
        }
      }),
    );
  });

  it('refuses whenever a set retention is below its floor', () => {
    fc.assert(
      fc.property(
        atArb,
        fc.constantFrom(...PURGE_TARGETS),
        fc.integer({ min: -5, max: 29 }),
        (at, target, days) => {
          const retention = {
            erasure_ledger: null,
            expired_link_requests: null,
            ended_sessions: null,
            account_tombstones: null,
            alert_decision_log: null,
            alert_digest_log: null,
            [target]: days,
          } as PurgeRetention;
          const belowFloor = days < 0 || days * DAY_MS < PURGE_TARGET_SPECS[target].floorMs;
          if (belowFloor) expect(() => planPurge(at, retention)).toThrow(PurgeRetentionError);
          else expect(planPurge(at, retention).some((step) => step.armed)).toBe(true);
        },
      ),
    );
  });
});

describe('retainedTemplateParams, for any parameters', () => {
  it('keeps a subset: only listed keys, each with its original value', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue()),
        fc.array(fc.string({ maxLength: 8 }), { maxLength: 5 }),
        (params, keys) => {
          const kept = retainedTemplateParams(params, keys);
          for (const [key, value] of Object.entries(kept)) {
            expect(keys).toContain(key);
            expect(value).toEqual(params[key]);
          }
          for (const key of keys) {
            if (Object.hasOwn(params, key)) expect(Object.hasOwn(kept, key)).toBe(true);
          }
        },
      ),
    );
  });
});
