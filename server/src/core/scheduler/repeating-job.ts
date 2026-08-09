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
 *  3. **Shutdown is prompt.** The pause is abortable, so SIGTERM does not wait out a
 *     ten-minute sleep and get escalated to SIGKILL mid-write.
 */

import type { Clock, EpochMs } from '../ports/clock.js';
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
}

export interface JobStats {
  readonly runs: number;
  /** Runs that threw, plus runs whose report threw — both mean "something is wrong". */
  readonly failures: number;
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

  // The first run happens immediately. A worker that restarts at 12:07 has nothing to
  // gain from waiting until 12:10, and the freshness clock is already ticking.
  while (!signal.aborted) {
    const startedAt = clock.now();
    let value: T | undefined;
    let error: unknown = NOTHING_THROWN;
    try {
      value = await options.run();
    } catch (thrown: unknown) {
      error = thrown;
    }
    const finishedAt = clock.now();
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

  return { runs, failures, stoppedAt: clock.now() };
}

/** Exported for the test that pins the overrun behaviour, and for readability. */
export function pauseMs(intervalMs: number, elapsedMs: number): number {
  return Math.max(MIN_PAUSE_MS, intervalMs - elapsedMs);
}
