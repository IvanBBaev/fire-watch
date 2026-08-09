import { describe, expect, it } from 'vitest';

import type { HeartbeatJobId } from '@fire-watch/contracts';

import type { IngestCycleReport, SourceIngestResult } from '../core/ingest/ingest-cycle.js';
import type { Heartbeat } from '../core/ports/heartbeat.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { reportCycle } from './cycle-reporter.js';

const STARTED_AT = 1_754_130_600_000; // 2025-08-02T11:30:00Z
const FINISHED_AT = STARTED_AT + 45_000;

const SOURCE_RESULT: SourceIngestResult = {
  source: 'firms:viirs:snpp',
  outcome: 'stored',
  availableAt: STARTED_AT,
  received: 1,
  inserted: 1,
  alreadyPresent: 0,
  rejected: 0,
  quarantined: 0,
  duplicatesWithinBatch: 0,
  anomaly: null,
  error: null,
};

function cycle(...sources: readonly SourceIngestResult[]): IngestCycleReport {
  return { startedAt: STARTED_AT, finishedAt: FINISHED_AT, sources };
}

function completedRun(value: IngestCycleReport): JobRun<IngestCycleReport> {
  return { startedAt: STARTED_AT, finishedAt: FINISHED_AT, value, error: null };
}

interface FakeHeartbeat extends Heartbeat {
  readonly pings: HeartbeatJobId[];
}

function fakeHeartbeat(): FakeHeartbeat {
  const pings: HeartbeatJobId[] = [];
  return {
    pings,
    succeeded(job: HeartbeatJobId): Promise<void> {
      pings.push(job);
      return Promise.resolve();
    },
  };
}

describe('reportCycle', () => {
  it("pings the dead-man's switch exactly once for a healthy cycle", async () => {
    const heartbeat = fakeHeartbeat();
    const lines: string[] = [];

    await reportCycle(completedRun(cycle(SOURCE_RESULT)), {
      heartbeat,
      writeLine: (line) => lines.push(line),
    });

    // The slug *is* the job id (OPERATIONS §3): one secret, one check per job.
    expect(heartbeat.pings).toEqual(['ingest-cycle']);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      ingest_cycle: { startedAt: STARTED_AT, finishedAt: FINISHED_AT },
      degraded: false,
    });
  });

  it('stays quiet for a degraded cycle, so healthchecks pages instead of snoozing', async () => {
    // This is the gate the whole leg depends on: a worker failing every cycle must go
    // quiet, not keep reporting "alive" from a `finally` or an unconditional ping.
    const heartbeat = fakeHeartbeat();
    const lines: string[] = [];
    const failedCycle = cycle(
      { ...SOURCE_RESULT, outcome: 'poll_failed', error: 'EAI_AGAIN' },
      { ...SOURCE_RESULT, outcome: 'write_failed', error: 'connection refused' },
    );

    await reportCycle(completedRun(failedCycle), {
      heartbeat,
      writeLine: (line) => lines.push(line),
    });

    expect(heartbeat.pings).toEqual([]);
    // The cycle is still logged — silence towards the monitor is not silence in the log.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ degraded: true });
  });

  it('does not treat one source being out as a failed cycle', async () => {
    // A single outage is the freshness budgets' problem (C5 §1.2), not the heartbeat's:
    // a switch that goes quiet whenever one satellite is late would page for weather.
    const heartbeat = fakeHeartbeat();
    const mixedCycle = cycle(SOURCE_RESULT, {
      ...SOURCE_RESULT,
      outcome: 'poll_failed',
      error: 'HTTP 503',
    });

    await reportCycle(completedRun(mixedCycle), {
      heartbeat,
      writeLine: () => undefined,
    });

    expect(heartbeat.pings).toEqual(['ingest-cycle']);
  });

  it('stays quiet when the run itself threw and there is no report at all', async () => {
    const heartbeat = fakeHeartbeat();
    const lines: string[] = [];
    const thrownRun: JobRun<IngestCycleReport> = {
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      value: undefined,
      error: new Error('wiring exploded before the first source'),
    };

    await reportCycle(thrownRun, { heartbeat, writeLine: (line) => lines.push(line) });

    expect(heartbeat.pings).toEqual([]);
    // The failure line is all the evidence there will be, so it carries the error and when.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ingest_cycle_failed: {
        error: 'wiring exploded before the first source',
        at: FINISHED_AT,
      },
    });
  });
});
