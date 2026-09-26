import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import type { AlertDecision } from './alert-decision.js';
import { decisionLogEntryFor } from './decision-log.js';
import { branchOf } from './explain.js';

const AT = epochMsFromIso('2026-08-14T12:00:00Z');

function decision(overrides: Partial<AlertDecision> = {}): AlertDecision {
  return {
    zoneId: 'zone-a',
    eventPublicId: 'fw-2026-a1b2c',
    outcome: 'defer',
    reason: 'quiet_hours',
    alertType: 'new_fire',
    alertSubkey: 'once',
    priority: 1,
    ladderStep: 0,
    inQuietHours: true,
    ruleVersion: 'alert_gating_v1',
    nextState: null,
    ...overrides,
  };
}

const CONTEXT = {
  fireEventId: '42',
  triggerRefSeq: '7',
  pass: 'evaluation',
  decidedAt: AT,
} as const;

describe('decisionLogEntryFor', () => {
  it('projects the decision and takes its code from the branch table', () => {
    expect(decisionLogEntryFor(decision(), CONTEXT)).toEqual({
      zoneId: 'zone-a',
      fireEventId: '42',
      triggerRefSeq: '7',
      pass: 'evaluation',
      outcome: 'defer',
      reason: 'quiet_hours',
      code: branchOf('defer', 'quiet_hours').code,
      alertType: 'new_fire',
      ladderStep: 0,
      inQuietHours: true,
      ruleVersion: 'alert_gating_v1',
      decidedAtIso: '2026-08-14T12:00:00Z',
    });
  });

  it('keeps an untyped suppress untyped', () => {
    const entry = decisionLogEntryFor(
      decision({ outcome: 'suppress', reason: 'cooldown', alertType: null, inQuietHours: false }),
      { ...CONTEXT, pass: 'zone_creation' },
    );
    expect(entry.code).toBe('suppressed_cooldown');
    expect(entry.alertType).toBeNull();
    expect(entry.pass).toBe('zone_creation');
  });

  it('refuses a digest type, which no decideAlert decision carries', () => {
    expect(() => decisionLogEntryFor(decision({ alertType: 'digest' }), CONTEXT)).toThrow(
      RangeError,
    );
  });

  it('refuses a pair decideAlert never produces', () => {
    expect(() =>
      decisionLogEntryFor(decision({ outcome: 'send', reason: 'cooldown' }), CONTEXT),
    ).toThrow(RangeError);
  });
});
