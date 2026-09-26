import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import {
  check,
  createStepRecorder,
  drillVerdict,
  messageOf,
  type DrillStepDefinition,
} from './drill-record.js';
import { evaluateRto } from './rto.js';

const AUTO: DrillStepDefinition = { id: 'auto', title: 'Auto', mode: 'automated', onRtoPath: true };
const HAND: DrillStepDefinition = { id: 'hand', title: 'Hand', mode: 'manual', onRtoPath: true };

describe('createStepRecorder', () => {
  it('times a passing step on the clock and describes its result', async () => {
    const clock = new VirtualClock('2026-09-25T10:00:00Z');
    const steps = createStepRecorder(clock);
    const result = await steps.run(
      AUTO,
      () => {
        clock.advanceMinutes(3);
        return Promise.resolve(42);
      },
      (value) => `got ${String(value)}`,
    );
    expect(result).toBe(42);
    expect(steps.steps()).toEqual([
      {
        ...AUTO,
        status: 'passed',
        startedAt: '2026-09-25T10:00:00Z',
        durationMs: 180_000,
        detail: 'got 42',
      },
    ]);
  });

  it('records a throwing step as failed and rethrows', async () => {
    const clock = new VirtualClock('2026-09-25T10:00:00Z');
    const steps = createStepRecorder(clock);
    await expect(
      steps.run(AUTO, () => {
        clock.advanceMs(500);
        return Promise.reject(new Error('pg_restore exited 1'));
      }),
    ).rejects.toThrow('pg_restore exited 1');
    expect(steps.steps()[0]).toMatchObject({
      status: 'failed',
      durationMs: 500,
      detail: 'pg_restore exited 1',
    });
  });

  it('records manual minutes, unreported manual steps and skips', () => {
    const steps = createStepRecorder(new VirtualClock(0));
    steps.manual(HAND, 12.5);
    steps.manual(HAND, null);
    steps.skip(AUTO, '--restore-only');
    expect(steps.steps().map((s) => [s.status, s.durationMs, s.startedAt])).toEqual([
      ['passed', 750_000, null],
      ['not_performed', null, null],
      ['skipped', null, null],
    ]);
  });
});

describe('drillVerdict', () => {
  const passedStep = {
    ...AUTO,
    status: 'passed' as const,
    startedAt: null,
    durationMs: 1,
    detail: '',
  };

  it('passes only with checks, all passing, and no RTO gap', () => {
    expect(
      drillVerdict({ steps: [passedStep], checks: [check('a', 'A', 'pass', '', '')], rto: null }),
    ).toBe('passed');
  });

  it('is incomplete with no checks or a not_run check', () => {
    expect(drillVerdict({ steps: [passedStep], checks: [], rto: null })).toBe('incomplete');
    expect(
      drillVerdict({
        steps: [passedStep],
        checks: [check('a', 'A', 'not_run', '', '')],
        rto: null,
      }),
    ).toBe('incomplete');
  });

  it('fails on a failed step or check, even beside a not_run', () => {
    const failed = { ...passedStep, status: 'failed' as const };
    expect(
      drillVerdict({ steps: [failed], checks: [check('a', 'A', 'pass', '', '')], rto: null }),
    ).toBe('failed');
    expect(
      drillVerdict({
        steps: [passedStep],
        checks: [check('a', 'A', 'not_run', '', ''), check('b', 'B', 'fail', '', '')],
        rto: null,
      }),
    ).toBe('failed');
  });

  it('follows the RTO: exceeded fails, incomplete is incomplete', () => {
    const checks = [check('a', 'A', 'pass', '', '')];
    const long = { ...passedStep, durationMs: 300 * 60_000 };
    expect(drillVerdict({ steps: [long], checks, rto: evaluateRto([long]) })).toBe('failed');
    const missing = { ...passedStep, status: 'not_performed' as const };
    expect(
      drillVerdict({
        steps: [passedStep, missing],
        checks,
        rto: evaluateRto([passedStep, missing]),
      }),
    ).toBe('incomplete');
  });
});

describe('messageOf', () => {
  it('reads an Error message or stringifies anything else', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf('plain')).toBe('plain');
  });
});
