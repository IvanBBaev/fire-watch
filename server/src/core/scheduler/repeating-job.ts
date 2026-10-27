/**
 * The loop that turns one ingest cycle into "recording continuously" (TASKS C1).
 *
 * Scheduling lives inside the worker process rather than in cron or a systemd timer
 * (OPERATIONS §9.1): the job code is then able to ping its heartbeat and export its own
 * metrics (C5), and an overrun is something this loop can see rather than something the
 * scheduler papers over by starting a second copy.
 *
 * Three properties matter more than anything else here, because the season is four
 * months long and nobody is watching at 03:00:
 *
 *  1. **It never throws.** A failing run is reported and the next one still happens. A
 *     worker that dies on the first transient DNS failure stops recording for the rest
 *     of the season — the exact outcome the whole project exists to avoid.
 *  2. **Runs never overlap.** The next pause is measured from the end of the run, so a
 *     cycle that took longer than the interval delays the next one instead of racing it.
 *     Across processes that is the optional `lock`'s job: a cycle whose lock another
 *     worker holds is skipped, not run alongside.
 *  3. **Shutdown is prompt.** The pause is abortable, so SIGTERM does not wait out a
 *     ten-minute sleep and get escalated to SIGKILL mid-write.
 */

import type { Clock, EpochMs } from '../ports/clock.js';
import type { LoopLock } from '../ports/loop-lock.js';
import type { Sleeper } from '../ports/sleeper.js';

/**
 * A run that overran its interval still gets a pause. Without one, a job that fails
 * instantly — a bad configuration, a closed port — becomes a spin loop that hammers
 * upstream and fills the disk with logs.
 */
export const MIN_PAUSE_MS = 1_000;

export interface JobRun<T> {
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs;
  /** The run's value, or `undefined` when it threw. */
  readonly value: T | undefined;
  /**
   * What the run threw, or `null` when it did not. A run that threw `null` itself is
   * indistinguishable here, but it is still counted as a failure — see {@link JobStats}.
   */
  readonly error: unknown;
}

/** A cycle that did not run because another worker holds the loop's lock. */
export interface JobSkip {
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs;
  readonly reason: 'lock_held';
}

export interface RepeatingJobOptions<T> {
  /** Nominal cadence, measured end-of-run to start-of-run. */
  readonly intervalMs: number;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  /** Aborting it stops the loop: mid-pause immediately, mid-run after the run returns. */
  readonly signal: AbortSignal;
  run(): Promise<T>;
  /**
   * Called after every run, and awaited. If it throws or rejects, the loop counts it and
   * carries on.
   *
   * Awaited because this is where the heartbeat is sent (C5, OPERATIONS §3): a ping fired
   * and forgotten would race the pause, and on the last cycle before SIGTERM it would race
   * process exit — so the dead-man's switch would go quiet on a clean shutdown, which is
   * the one time it must not.
   */
  report?(run: JobRun<T>): void | Promise<void>;
  /**
   * The cross-process singleton guard (`core/ports/loop-lock.ts`). Each run happens inside
   * it; a cycle that finds it held elsewhere is skipped: `run` and `report` are not
   * called — so no heartbeat is pinged on another worker's behalf — and `skipped` is.
   * Absent, every cycle runs, as it did before there was a guard.
   */
  readonly lock?: LoopLock;
  /** Called for every skipped cycle, and awaited. A throw counts as a failure, like `report`'s. */
  skipped?(skip: JobSkip): void | Promise<void>;
}

export interface JobStats {
  readonly runs: number;
  /** Runs that threw, plus runs whose report threw — both mean "something is wrong". */
  readonly failures: number;
  /**
   * Cycles not run because another worker held the loop's lock. Not failures: the holder
   * is doing the work. A standby worker's stats are all skips.
   */
  readonly skipped: number;
  readonly stoppedAt: EpochMs;
}

/**
 * The "nothing was thrown" marker. Not `null`, because `throw null` is legal JavaScript:
 * a null sentinel would classify that run as a success with an undefined value. A local
 * symbol is a value no `run()` can ever throw, so any thrown value counts as the failure
 * it is — and it never leaks into a {@link JobRun}, whose `error` stays `null` on success.
 */
const NOTHING_THROWN: unique symbol = Symbol('nothing thrown');

export async function runRepeatedly<T>(options: RepeatingJobOptions<T>): Promise<JobStats> {
  const { intervalMs, clock, sleeper, signal } = options;
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_PAUSE_MS) {
    throw new RangeError(
      `interval must be at least ${String(MIN_PAUSE_MS)} ms, got ${String(intervalMs)}`,
    );
  }

  let runs = 0;
  let failures = 0;
  let skipped = 0;

  // The first run happens immediately. A worker that restarts at 12:07 has nothing to
  // gain from waiting until 12:10, and the freshness clock is already ticking.
  while (!signal.aborted) {
    const startedAt = clock.now();
    let value: T | undefined;
    let error: unknown = NOTHING_THROWN;
    let held = false;
    try {
      if (options.lock === undefined) {
        value = await options.run();
      } else {
        const exclusive = await options.lock.runExclusive(() => options.run());
        if (exclusive.acquired) value = exclusive.value;
        else held = true;
      }
    } catch (thrown: unknown) {
      // A lock that could not even be asked for is a failed run: the database it lives in
      // is the one the run needs, and a worker that cannot reach it is not "standing by".
      error = thrown;
    }
    const finishedAt = clock.now();

    if (held) {
      skipped += 1;
      if (options.skipped) {
        try {
          await options.skipped({ startedAt, finishedAt, reason: 'lock_held' });
        } catch {
          failures += 1;
        }
      }
      if (signal.aborted) break;
      await sleeper.sleep(pauseMs(intervalMs, finishedAt - startedAt), signal);
      continue;
    }

    const failed = error !== NOTHING_THROWN;
    runs += 1;
    if (failed) failures += 1;

    if (options.report) {
      try {
        await options.report({ startedAt, finishedAt, value, error: failed ? error : null });
      } catch {
        // A logger that throws must not be able to stop ingestion. It is still a fault,
        // so it counts — a rising failure count with healthy cycles points straight here.
        failures += 1;
      }
    }

    if (signal.aborted) break;
    await sleeper.sleep(pauseMs(intervalMs, finishedAt - startedAt), signal);
  }

  return { runs, failures, skipped, stoppedAt: clock.now() };
}

/** Exported for the test that pins the overrun behaviour, and for readability. */
export function pauseMs(intervalMs: number, elapsedMs: number): number {
  return Math.max(MIN_PAUSE_MS, intervalMs - elapsedMs);
}
