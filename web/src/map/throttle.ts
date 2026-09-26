/**
 * Store→map update throttle: at most one flush per interval (default 1 s), each flush
 * aligned to a scheduler frame (review 08 §5.3.1 — `setData` throttled to 1/s and
 * coalesced through `requestAnimationFrame`).
 *
 * Both time sources are injected — a frame scheduler and the monotonic clock — so tests
 * replay the exact sequence with fakes. There is no `setTimeout` in here: while a flush
 * is pending during cooldown the throttle re-checks the clock once per scheduled frame
 * (≤ ~60 cheap comparisons per second, only while dirty). With the real rAF scheduler
 * this also means frames stop in a hidden tab and the trailing flush lands on the first
 * visible frame — exactly when pushing data to the map becomes worth anything.
 */

import type { Clock } from '../core/ports.js';

/** rAF-shaped seam: `schedule` runs the callback on the next frame, `cancel` revokes. */
export interface FrameScheduler {
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface FrameThrottleDeps {
  readonly clock: Pick<Clock, 'monotonicNow'>;
  readonly scheduler: FrameScheduler;
  /** Minimum ms between two flushes. Defaults to {@link DEFAULT_FLUSH_INTERVAL_MS}. */
  readonly intervalMs?: number;
  /** The flush. Reads the latest state itself, so coalesced requests lose nothing. */
  readonly callback: () => void;
}

export interface FrameThrottle {
  /** Note that state changed. Coalesces freely; the trailing change always flushes. */
  request(): void;
  /** Cancel any pending frame and refuse further requests. Safe to call twice. */
  dispose(): void;
}

export const DEFAULT_FLUSH_INTERVAL_MS = 1_000;

export function createFrameThrottle(deps: FrameThrottleDeps): FrameThrottle {
  const intervalMs = deps.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  let pendingHandle: unknown = null;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const onFrame = (): void => {
    pendingHandle = null;
    if (disposed) return;
    const now = deps.clock.monotonicNow();
    if (now - lastFlushAt < intervalMs) {
      // Cooling down — keep the pending flush alive and check again next frame.
      pendingHandle = deps.scheduler.schedule(onFrame);
      return;
    }
    lastFlushAt = now;
    deps.callback();
  };

  return {
    request(): void {
      if (disposed || pendingHandle !== null) return;
      pendingHandle = deps.scheduler.schedule(onFrame);
    },
    dispose(): void {
      disposed = true;
      if (pendingHandle !== null) {
        deps.scheduler.cancel(pendingHandle);
        pendingHandle = null;
      }
    },
  };
}
