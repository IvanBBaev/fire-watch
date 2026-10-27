/**
 * The worker's singleton guard: one holder per loop across every worker process that
 * points at the same database (ADR-002 "single-writer worker"; OPERATIONS §9.3).
 *
 * `runRepeatedly` already keeps one process's runs from overlapping. What it cannot see is
 * a second process — a deploy whose old worker has not drained yet, a restart racing a
 * supervisor, an operator's `pnpm worker` against production. Ingest's idempotent writes
 * survive that, but two alert evaluators would each read the same transition and two
 * dispatchers would each count G's window as theirs: ADR-004 D1's "the row status guard
 * suffices because there is a single dispatcher" stops being true the moment there are two.
 *
 * The guard is per cycle, not per process: the cycle that finds the lock held is
 * *skipped* — no run, no report, no heartbeat — and the next cycle tries again, so the
 * standby takes over within one interval of the holder going away. A skip is not a
 * failure and must never page (J1): the holder is doing the work, and it is the holder's
 * heartbeat and metrics that say so.
 */

/** The loops that must have one runner per database. */
export const LOCKED_LOOPS = ['ingest', 'alert_evaluation', 'dispatch'] as const;

export type LockedLoop = (typeof LOCKED_LOOPS)[number];

/** The body ran under the lock and returned `value`, or the lock was held elsewhere. */
export type Exclusive<T> =
  { readonly acquired: true; readonly value: T } | { readonly acquired: false };

export interface LoopLock {
  /**
   * Runs `body` while holding the lock and releases it afterwards, whatever `body` did.
   * Resolves `{ acquired: false }` without running `body` when another holder has it.
   * Rejects with what `body` threw, or — before running it — when the lock itself could
   * not be asked for (an unreachable database is a failed cycle, not a skipped one).
   */
  runExclusive<T>(body: () => Promise<T>): Promise<Exclusive<T>>;
}

export interface LoopLocks {
  forLoop(loop: LockedLoop): LoopLock;
  /** Releases whatever the locks hold open. Idempotent. */
  close(): Promise<void>;
}

/**
 * The lock for a process that is the only runner by construction — a one-shot CLI, a
 * test. Explicit, like `noopHeartbeat`, so "unguarded" is a visible choice at the wiring
 * site rather than an optional dependency.
 */
export const unguardedLoopLock: LoopLock = {
  async runExclusive<T>(body: () => Promise<T>): Promise<Exclusive<T>> {
    return { acquired: true, value: await body() };
  },
};
