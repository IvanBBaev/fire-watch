import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import type { Sleeper } from '../ports/sleeper.js';
import type { JobRun } from './repeating-job.js';
import { MIN_PAUSE_MS, pauseMs, runRepeatedly } from './repeating-job.js';

const START = '2026-08-02T11:30:00Z';
const INTERVAL_MS = 600_000; // 10 minutes — the FIRMS cadence (DATA-SOURCES §A1).

interface FakeSleeper extends Sleeper {
  readonly pauses: number[];
}

/**
 * Time only moves when the scheduler asks to wait, which is what makes these tests both
 * instant and deterministic. `stopAfter` aborts the given controller once that many
 * pauses have been requested — the test's stand-in for SIGTERM.
 */
function fakeSleeper(clock: VirtualClock, controller: AbortController, stopAfter = 1): FakeSleeper {
  const pauses: number[] = [];
  return {
    pauses,
    sleep(ms: number): Promise<void> {
      pauses.push(ms);
      clock.advanceMs(ms);
      if (pauses.length >= stopAfter) controller.abort();
      return Promise.resolve();
    },
  };
}

describe('runRepeatedly', () => {
  it('runs once immediately instead of waiting out the first interval', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const sleeper = fakeSleeper(clock, controller);
    const order: string[] = [];

    const stats = await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: () => {
        order.push('run');
        return Promise.resolve('ok');
      },
    });

    // A worker that restarted at 12:07 must not leave the map ten minutes stale.
    expect(order).toEqual(['run']);
    expect(stats).toMatchObject({ runs: 1, failures: 0 });
  });

  it('keeps going until it is told to stop', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const sleeper = fakeSleeper(clock, controller, 3);
    let runs = 0;

    const stats = await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: () => {
        runs += 1;
        return Promise.resolve(runs);
      },
    });

    expect(runs).toBe(3);
    expect(stats.runs).toBe(3);
    expect(sleeper.pauses).toEqual([INTERVAL_MS, INTERVAL_MS, INTERVAL_MS]);
  });

  it('survives a run that threw, because one bad cycle is not the end of the season', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const sleeper = fakeSleeper(clock, controller, 2);
    const seen: unknown[] = [];
    let runs = 0;

    const stats = await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: () => {
        runs += 1;
        return runs === 1 ? Promise.reject(new Error('EAI_AGAIN')) : Promise.resolve('ok');
      },
      report: (run) => {
        seen.push(run.error);
      },
    });

    expect(runs).toBe(2);
    expect(stats).toMatchObject({ runs: 2, failures: 1 });
    expect((seen[0] as Error).message).toBe('EAI_AGAIN');
    expect(seen[1]).toBeNull();
  });

  it('counts a run that threw null — any thrown value is a failure, not just an Error', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const sleeper = fakeSleeper(clock, controller);
    const seen: JobRun<string>[] = [];

    const stats = await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: (): Promise<string> => {
        // `throw null` is legal JavaScript. A `null` "nothing thrown" sentinel inside
        // the loop would have classified this run as a success with no value.
        const thrown: unknown = null;
        throw thrown;
      },
      report: (run) => {
        seen.push(run);
      },
    });

    expect(stats).toMatchObject({ runs: 1, failures: 1 });
    // The report sees the failed branch: no value to publish, nothing to ping about.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.value).toBeUndefined();
    expect(seen[0]?.error).toBeNull();
  });

  it('measures the pause from the end of the run, so two runs never overlap', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const sleeper = fakeSleeper(clock, controller);

    await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: () => {
        clock.advanceMs(90_000); // a slow poll: three sources, one of them timing out
        return Promise.resolve('ok');
      },
    });

    expect(sleeper.pauses).toEqual([INTERVAL_MS - 90_000]);
  });

  it('still pauses after a run that overran its whole interval', () => {
    // Without a floor, a job that fails instantly — bad config, closed port — becomes a
    // spin loop against upstream.
    expect(pauseMs(INTERVAL_MS, INTERVAL_MS * 2)).toBe(MIN_PAUSE_MS);
    expect(pauseMs(INTERVAL_MS, 0)).toBe(INTERVAL_MS);
  });

  it('does not start a run once it has been told to stop', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const sleeper = fakeSleeper(clock, controller);
    let runs = 0;

    const stats = await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: () => {
        runs += 1;
        controller.abort(); // SIGTERM arriving mid-cycle
        return Promise.resolve('ok');
      },
    });

    // The cycle in flight finishes — a write we have already started is not abandoned —
    // and nothing is scheduled after it, not even a pause.
    expect(runs).toBe(1);
    expect(sleeper.pauses).toEqual([]);
    expect(stats.runs).toBe(1);
  });

  it('still reports the final run when the stop arrived during it', async () => {
    // The abort check sits BELOW the report block deliberately (see `report`'s docstring):
    // the last cycle before SIGTERM is the one whose heartbeat must not be skipped, or the
    // dead-man's switch goes quiet on every clean shutdown. This pins the ordering.
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const sleeper = fakeSleeper(clock, controller);
    const reported: (string | undefined)[] = [];

    await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: () => {
        controller.abort(); // SIGTERM arriving mid-cycle
        return Promise.resolve('final cycle');
      },
      report: (run) => {
        reported.push(run.value);
      },
    });

    expect(reported).toEqual(['final cycle']);
    expect(sleeper.pauses).toEqual([]);
  });

  it('does nothing at all when it starts already stopped', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    controller.abort();
    let runs = 0;

    const stats = await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper: fakeSleeper(clock, controller),
      signal: controller.signal,
      run: () => {
        runs += 1;
        return Promise.resolve('ok');
      },
    });

    expect(runs).toBe(0);
    expect(stats).toMatchObject({ runs: 0, failures: 0 });
  });

  it('counts a reporter that threw without letting it stop ingestion', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const sleeper = fakeSleeper(clock, controller, 2);
    let runs = 0;

    const stats = await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: () => {
        runs += 1;
        return Promise.resolve('ok');
      },
      report: () => {
        throw new Error('EPIPE writing to stdout');
      },
    });

    expect(runs).toBe(2);
    expect(stats).toMatchObject({ runs: 2, failures: 2 });
  });

  it('waits for a reporter that returns a promise', async () => {
    // This is where the heartbeat is sent (C5). A ping fired and forgotten would race the
    // pause, and on the last cycle before SIGTERM it would race process exit — so the
    // dead-man's switch would go quiet on a clean shutdown, the one time it must not.
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const order: string[] = [];
    const sleeper: Sleeper = {
      sleep: (ms: number): Promise<void> => {
        order.push('pause');
        clock.advanceMs(ms);
        controller.abort();
        return Promise.resolve();
      },
    };

    await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: () => {
        order.push('run');
        return Promise.resolve('ok');
      },
      report: async () => {
        await Promise.resolve();
        order.push('heartbeat');
      },
    });

    expect(order).toEqual(['run', 'heartbeat', 'pause']);
  });

  it('counts a reporter that rejected, and still keeps going', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const sleeper = fakeSleeper(clock, controller, 2);
    let runs = 0;

    const stats = await runRepeatedly({
      intervalMs: INTERVAL_MS,
      clock,
      sleeper,
      signal: controller.signal,
      run: () => {
        runs += 1;
        return Promise.resolve('ok');
      },
      report: () => Promise.reject(new Error('hc-ping.io is unreachable')),
    });

    expect(runs).toBe(2);
    expect(stats).toMatchObject({ runs: 2, failures: 2 });
  });

  it('refuses an interval that would amount to a busy loop', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();

    await expect(
      runRepeatedly({
        intervalMs: 0,
        clock,
        sleeper: fakeSleeper(clock, controller),
        signal: controller.signal,
        run: () => Promise.resolve('ok'),
      }),
    ).rejects.toThrow(/at least 1000 ms/);
  });
});
