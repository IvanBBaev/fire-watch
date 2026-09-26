import { SCORE_BUCKET_FLOOR } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import {
  ALERT_GATING,
  ESCALATION_LADDER,
  TRIGGER_TYPES,
  ladderStepOf,
  minuteOfDay,
  priorityFor,
  type EscalationRung,
  type TriggerType,
} from './alert-gating.js';

describe('alert_gating_v1', () => {
  it('cites a version that a stored outbox row can be read against', () => {
    expect(ALERT_GATING.version).toBe('alert_gating_v1');
    expect(ALERT_GATING.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('pins the digest, because a refit that forgot to bump the version is invisible', () => {
    // S13 replays against `alert_gating_v1` by name. If someone widens the suppression
    // window and leaves the version alone, the fixture goes on claiming it asserted the
    // old rule set — the same failure `lifecycle_params` pins its digest against.
    expect(ALERT_GATING.digest).toBe('d99efc28');
  });

  it('keeps the gate table and the score buckets from drifting apart', () => {
    // Two tables, one boundary. If ADR-002 moves "Confirmed" and this file does not, a
    // zone set to "only confirmed fires" starts alerting on Likely ones.
    expect(ALERT_GATING.values.sensitivityFloors.confirmed).toBe(SCORE_BUCKET_FLOOR.confirmed);
    expect(ALERT_GATING.values.sensitivityFloors.likely).toBe(SCORE_BUCKET_FLOOR.likely);
  });

  it('matches the system default the schema writes into watch_zones.min_score', () => {
    expect(ALERT_GATING.values.systemScoreFloor).toBe(0.45);
    expect(ALERT_GATING.values.sensitivityFloors.earlySignals).toBe(0.3);
  });

  it('keeps the digest floor strictly inside the suppression window', () => {
    // The two limits compose; a floor wider than the window would mean the tighter rule
    // is the looser one and the reason on a decision would name the wrong limit.
    expect(ALERT_GATING.values.digestFloorMs).toBeLessThan(ALERT_GATING.values.suppressionWindowMs);
  });
});

describe('the ladder', () => {
  it('numbers the rungs one-based, in array order', () => {
    expect(ESCALATION_LADDER.map((rung) => ladderStepOf(rung))).toEqual([1, 2, 3]);
  });

  it('rejects a rung that is not on this version of the ladder', () => {
    expect(() => ladderStepOf('area_halving' as EscalationRung)).toThrow(RangeError);
  });
});

describe('queue priority (A1.2)', () => {
  it('sorts manual work ahead of automatic alerts and digests last', () => {
    expect(TRIGGER_TYPES.map((trigger) => priorityFor(trigger))).toEqual([0, 10, 20, 30]);
  });

  it('rejects a trigger type it has no class for', () => {
    expect(() => priorityFor('telemetry' as TriggerType)).toThrow(RangeError);
  });
});

describe('reading a quiet-hours boundary', () => {
  it('parses the wall-clock times the account table stores', () => {
    expect(minuteOfDay('22:00')).toBe(1320);
    expect(minuteOfDay('07:00')).toBe(420);
    expect(minuteOfDay('00:00')).toBe(0);
  });

  it('refuses anything that is not exactly HH:MM', () => {
    // Postgres renders a `time` column as `22:00:00`; accepting it and dropping the tail
    // would be answering a question about text while claiming to answer one about time.
    expect(() => minuteOfDay('22:00:00')).toThrow(RangeError);
    expect(() => minuteOfDay('7:00')).toThrow(RangeError);
    expect(() => minuteOfDay('24:00')).toThrow(RangeError);
    expect(() => minuteOfDay('22:60')).toThrow(RangeError);
  });
});
