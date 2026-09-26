import { describe, expect, it } from 'vitest';

import type { DrillStep } from './drill-record.js';
import {
  evaluateRto,
  MANUAL_RTO_STEPS,
  parseManualStep,
  RESTORE_RTO,
  RTO_PATH_STEPS,
} from './rto.js';

function step(
  id: string,
  status: DrillStep['status'],
  minutes: number | null,
  onRtoPath = true,
): DrillStep {
  return {
    id,
    title: id,
    mode: 'manual',
    onRtoPath,
    status,
    startedAt: null,
    durationMs: minutes === null ? null : minutes * 60_000,
    detail: '',
  };
}

const ALL_PATH = Object.values(RTO_PATH_STEPS).map((s) => s.id);

describe('evaluateRto', () => {
  it('is met when every path step passed within 4 h, and ignores off-path steps', () => {
    const steps = [
      step('take_backup', 'passed', 999, false),
      ...ALL_PATH.map((id) => step(id, 'passed', 30)),
    ];
    expect(evaluateRto(steps)).toMatchObject({
      status: 'met',
      measuredMinutes: 180,
      missing: [],
      failed: [],
    });
  });

  it('is incomplete, with the measured time a lower bound, when a path step was not performed', () => {
    const steps = ALL_PATH.map((id) =>
      step(id, id === 'flip_origin' ? 'not_performed' : 'passed', 10),
    );
    expect(evaluateRto(steps)).toMatchObject({
      status: 'incomplete',
      measuredMinutes: 50,
      missing: ['flip_origin'],
    });
  });

  it('is exceeded when even a lower bound passes 4 h', () => {
    const steps = [step('provision_vm', 'passed', 241), step('flip_origin', 'not_performed', null)];
    expect(evaluateRto(steps).status).toBe('exceeded');
  });

  it('is failed when a path step failed, whatever the time', () => {
    expect(evaluateRto([step('restore_database', 'failed', 1)])).toMatchObject({
      status: 'failed',
      failed: ['restore_database'],
    });
  });

  it('is incomplete with no path steps at all', () => {
    expect(evaluateRto([step('x', 'passed', 1, false)]).status).toBe('incomplete');
  });

  it('rounds to a tenth of a minute and carries the documented target', () => {
    const rto = evaluateRto([{ ...step('provision_vm', 'passed', null), durationMs: 61_234 }]);
    expect(rto.measuredMinutes).toBe(1);
    expect([rto.targetMinMinutes, rto.targetMaxMinutes]).toEqual([
      RESTORE_RTO.targetMinMinutes,
      240,
    ]);
  });
});

describe('parseManualStep', () => {
  it('parses id:minutes, decimals included', () => {
    expect(parseManualStep('provision_vm:35')).toEqual({ id: 'provision_vm', minutes: 35 });
    expect(parseManualStep('flip_origin:2.5')).toEqual({ id: 'flip_origin', minutes: 2.5 });
  });

  it('refuses an automated step, an unknown id, a bad shape and out-of-range minutes', () => {
    expect(() => parseManualStep('restore_database:10')).toThrow(RangeError);
    expect(() => parseManualStep('nope:10')).toThrow(/unknown manual step/);
    expect(() => parseManualStep('provision_vm')).toThrow(/<id>:<minutes>/);
    expect(() => parseManualStep('provision_vm:0')).toThrow(/\(0, 1440\]/);
    expect(() => parseManualStep('provision_vm:1441')).toThrow(RangeError);
  });

  it('lists exactly the manual steps of the path', () => {
    expect(MANUAL_RTO_STEPS.map((s) => s.id)).toEqual([
      'provision_vm',
      'deploy_stack',
      'restore_secrets',
      'promote_and_boot',
      'flip_origin',
    ]);
  });
});
