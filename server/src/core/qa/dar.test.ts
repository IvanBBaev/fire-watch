import { describe, expect, it } from 'vitest';

import { ALERT_GATING } from '../config/alert-gating.js';
import { dar, type DispatchedAlert } from './dar.js';
import { QA_METRICS } from './qa-metrics-params.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 7, 20, 6, 0, 0);
const SUPPRESSION_MS = ALERT_GATING.values.suppressionWindowMs;

function alert(overrides: Partial<DispatchedAlert> = {}): DispatchedAlert {
  return {
    alertId: 'a1',
    zoneId: 'qa_grid-c018-r029',
    eventKey: 'evt-1',
    alertType: 'new_fire',
    dispatchedAtMs: T0,
    ladderStep: 0,
    ...overrides,
  };
}

describe('the suppression window', () => {
  it('is read from alert_gating_v1, not restated here', () => {
    expect(dar({ alerts: [] }).suppressionWindowMs).toBe(SUPPRESSION_MS);
    expect(SUPPRESSION_MS).toBe(6 * HOUR);
  });

  it('counts a repeat inside it as a duplicate', () => {
    const report = dar({
      alerts: [alert(), alert({ alertId: 'a2', dispatchedAtMs: T0 + HOUR })],
    });
    expect(report.duplicates).toEqual([{ alertId: 'a2', repeatsAlertId: 'a1', gapMs: HOUR }]);
    expect(report.rate).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it('counts a repeat at exactly the window edge — the window is closed', () => {
    const report = dar({
      alerts: [alert(), alert({ alertId: 'a2', dispatchedAtMs: T0 + SUPPRESSION_MS })],
    });
    expect(report.duplicates.map((entry) => entry.alertId)).toEqual(['a2']);
  });

  it('does not count one a millisecond later', () => {
    const report = dar({
      alerts: [alert(), alert({ alertId: 'a2', dispatchedAtMs: T0 + SUPPRESSION_MS + 1 })],
    });
    expect(report.duplicates).toEqual([]);
    expect(report.rate.numerator).toBe(0);
  });

  it('measures each repeat against the previous alert for the key, not the first', () => {
    // Three alerts 5 h apart: 1↔2 and 2↔3 are inside the window even though 1↔3 is not.
    const report = dar({
      alerts: [
        alert(),
        alert({ alertId: 'a2', dispatchedAtMs: T0 + 5 * HOUR }),
        alert({ alertId: 'a3', dispatchedAtMs: T0 + 10 * HOUR }),
      ],
    });
    expect(report.duplicates.map((entry) => [entry.alertId, entry.repeatsAlertId])).toEqual([
      ['a2', 'a1'],
      ['a3', 'a2'],
    ]);
  });
});

describe('the semantic key', () => {
  it('needs all three of zone, event and type to match', () => {
    const report = dar({
      alerts: [
        alert(),
        alert({ alertId: 'other-zone', zoneId: 'qa_grid-c019-r029', dispatchedAtMs: T0 + HOUR }),
        alert({ alertId: 'other-event', eventKey: 'evt-2', dispatchedAtMs: T0 + HOUR }),
        alert({ alertId: 'other-type', alertType: 'digest', dispatchedAtMs: T0 + HOUR }),
      ],
    });
    expect(report.duplicates).toEqual([]);
    expect(report.rate.denominator).toBe(4);
  });

  it('cannot be made to collide by ids containing the separator', () => {
    // ("a-b", "c") and ("a", "b-c") join to the same string without a length prefix, and
    // the second alert would then cancel as a duplicate of the first.
    const report = dar({
      alerts: [
        alert({ alertId: 'a1', zoneId: 'a-b', eventKey: 'c' }),
        alert({ alertId: 'a2', zoneId: 'a', eventKey: 'b-c', dispatchedAtMs: T0 + HOUR }),
      ],
    });
    expect(report.duplicates).toEqual([]);
  });

  it('folds a merge across the parent chain when the caller resolves the key', () => {
    // Two different `fire_events` rows, one fire: the re-notification after the merge is
    // the duplicate the formula names, and only a resolved key can see it.
    const report = dar({
      alerts: [
        alert({ alertId: 'before-merge', eventKey: 'evt-parent' }),
        alert({
          alertId: 'after-merge',
          eventKey: 'evt-parent',
          alertType: 'escalation',
          dispatchedAtMs: T0 + HOUR,
        }),
      ],
    });
    // Different alert types, so still not a duplicate — but the key did fold.
    expect(report.rate.denominator).toBe(2);
    const merged = dar({
      alerts: [
        alert({ alertId: 'before-merge', eventKey: 'evt-parent' }),
        alert({ alertId: 'after-merge', eventKey: 'evt-parent', dispatchedAtMs: T0 + HOUR }),
      ],
    });
    expect(merged.duplicates.map((entry) => entry.alertId)).toEqual(['after-merge']);
  });
});

describe('the escalation exemption', () => {
  it('exempts a repeat that climbed a rung', () => {
    const report = dar({
      alerts: [
        alert({ alertType: 'escalation', ladderStep: 1 }),
        alert({
          alertId: 'a2',
          alertType: 'escalation',
          ladderStep: 2,
          dispatchedAtMs: T0 + HOUR,
        }),
      ],
    });
    expect(report.duplicates).toEqual([]);
  });

  it('counts a repeat on the same rung, whatever else changed', () => {
    const report = dar({
      alerts: [
        alert({ alertType: 'escalation', ladderStep: 2 }),
        alert({
          alertId: 'a2',
          alertType: 'escalation',
          ladderStep: 2,
          dispatchedAtMs: T0 + HOUR,
        }),
      ],
    });
    expect(report.duplicates.map((entry) => entry.alertId)).toEqual(['a2']);
  });

  it('counts a repeat that dropped a rung', () => {
    const report = dar({
      alerts: [
        alert({ alertType: 'escalation', ladderStep: 3 }),
        alert({
          alertId: 'a2',
          alertType: 'escalation',
          ladderStep: 1,
          dispatchedAtMs: T0 + HOUR,
        }),
      ],
    });
    expect(report.duplicates.map((entry) => entry.alertId)).toEqual(['a2']);
  });
});

describe('the two targets', () => {
  const twenty = (duplicateCount: number): DispatchedAlert[] =>
    Array.from({ length: 20 }, (_unused, index) =>
      alert({
        alertId: `a${String(index)}`,
        // The first `duplicateCount` alerts share one key an hour apart; the rest are distinct.
        eventKey: index < duplicateCount + 1 ? 'shared' : `evt-${String(index)}`,
        dispatchedAtMs: T0 + index * HOUR,
      }),
    );

  it('passes the shadow target at exactly 5 % and fails the steady one', () => {
    const report = dar({ alerts: twenty(1) });
    expect(report.rate.rate).toBe(0.05);
    expect(report.shadowMaxRate).toBe(0.05);
    expect(report.steadyMaxRate).toBe(0.01);
    expect(report.meetsShadowTarget).toBe(true);
    expect(report.meetsSteadyTarget).toBe(false);
  });

  it('fails the shadow target one duplicate past it', () => {
    expect(dar({ alerts: twenty(2) }).meetsShadowTarget).toBe(false);
  });

  it('passes both when nothing repeated', () => {
    const report = dar({ alerts: twenty(0) });
    expect(report.rate.rate).toBe(0);
    expect(report.meetsShadowTarget).toBe(true);
    expect(report.meetsSteadyTarget).toBe(true);
  });
});

describe('an empty window', () => {
  it('reports the rate as absent and judges neither target', () => {
    const report = dar({ alerts: [] });
    expect(report.rate).toMatchObject({ numerator: 0, denominator: 0, rate: null });
    expect(report.meetsShadowTarget).toBeNull();
    expect(report.meetsSteadyTarget).toBeNull();
  });
});

describe('determinism', () => {
  it('does not depend on the order the alerts arrived in', () => {
    const alerts = [
      alert({ alertId: 'a1', dispatchedAtMs: T0 }),
      alert({ alertId: 'a2', dispatchedAtMs: T0 + HOUR }),
      alert({ alertId: 'a3', dispatchedAtMs: T0 + 2 * HOUR }),
    ];
    const forwards = dar({ alerts });
    const backwards = dar({ alerts: alerts.slice().reverse() });
    expect(backwards.duplicates).toEqual(forwards.duplicates);
  });

  it('breaks a same-millisecond tie by code unit, not by locale collation', () => {
    // Under `LC_ALL=tr_TR.UTF-8` a locale collation would order "I" and "i" differently
    // from every other machine, and the pair that counts as the repeat would change.
    const alerts = [
      alert({ alertId: 'I-alert' }),
      alert({ alertId: 'i-alert' }),
      alert({ alertId: 'ı-alert' }),
    ];
    const report = dar({ alerts });
    expect(report.duplicates.map((entry) => [entry.repeatsAlertId, entry.alertId])).toEqual([
      ['I-alert', 'i-alert'],
      ['i-alert', 'ı-alert'],
    ]);
    expect(report.duplicates.every((entry) => entry.gapMs === 0)).toBe(true);
  });
});

describe('corrupt input', () => {
  it('refuses a repeated alert id', () => {
    expect(() => dar({ alerts: [alert(), alert()] })).toThrow(/duplicate alert id/);
  });

  it('refuses a fractional or negative ladder step', () => {
    expect(() => dar({ alerts: [alert({ ladderStep: 1.5 })] })).toThrow(/rung is a non-negative/);
    expect(() => dar({ alerts: [alert({ ladderStep: -1 })] })).toThrow(/rung is a non-negative/);
  });

  it('refuses a non-finite dispatch instant', () => {
    expect(() => dar({ alerts: [alert({ dispatchedAtMs: Number.NaN })] })).toThrow(/non-finite/);
  });
});

describe('the report as an evidence artifact', () => {
  it('names the gating config version the rate was measured against', () => {
    const report = dar({ alerts: [] });
    expect(report.alertGatingVersion).toBe(ALERT_GATING.version);
    expect(report.configVersion).toBe(QA_METRICS.version);
    expect(report.configDigest).toBe(QA_METRICS.digest);
  });
});
