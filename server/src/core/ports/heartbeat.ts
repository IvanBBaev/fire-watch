/**
 * The dead-man's switch — leg 2 of the three-leg meta-alerting (OPERATIONS §3).
 *
 * The other two legs answer "is what it reports healthy?". This one answers "is it still
 * running at all?", and it answers it *off-box*: nothing on our VM has to notice, because
 * a VM that has stopped noticing is the failure being detected. That is the whole reason
 * the leg exists, and it is why the port is this small — anything richer would be a metric,
 * and metrics are leg 1.
 *
 * Two rules follow from that and are enforced at the call sites, not here:
 *
 *   * The ping goes out **after** the work succeeded. Never from a `finally`, which pings
 *     just as faithfully for a job that threw — a dead-man's switch wired to run whatever
 *     happens is a dead-man's switch that only detects power cuts.
 *   * A failed ping never fails the job. The monitoring must not be able to take down the
 *     thing it monitors; a missed ping is already a page from the other side.
 */

import type { HeartbeatJobId } from '@fire-watch/contracts';

export interface Heartbeat {
  /**
   * Reports that `job` completed successfully, just now. Resolves either way: an
   * implementation that cannot reach the monitor swallows it (see the module comment).
   */
  succeeded(job: HeartbeatJobId): Promise<void>;
}

/**
 * The heartbeat for a deployment that has none configured — a developer box, a test, the
 * one-shot CLI. Explicit rather than an optional dependency, so that "not configured"
 * is a visible choice at the wiring site instead of an `if` around every call.
 */
export const noopHeartbeat: Heartbeat = {
  succeeded(): Promise<void> {
    return Promise.resolve();
  },
};
