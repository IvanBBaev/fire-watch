/**
 * Waiting is a port for the same reason reading the time is (`clock.ts`): a scheduler
 * that calls `setTimeout` directly can only be tested by actually waiting, so its tests
 * are either slow or flaky, and the interesting cases — a cycle that overran its
 * interval, a shutdown that arrives mid-sleep — are the ones nobody writes.
 */

export interface Sleeper {
  /**
   * Resolves after `ms`, or as soon as `signal` aborts — whichever comes first.
   *
   * It never rejects: an interrupted sleep is the normal way a worker shuts down, not
   * an error, and a scheduler that has to catch its own pauses reads like one that
   * expects them to fail.
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
