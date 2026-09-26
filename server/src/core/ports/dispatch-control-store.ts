/**
 * Where D5's two switch positions live — the kill switch and the breaker latch.
 *
 * `dispatch-breaker.ts` holds the rule and says outright that it holds no state: "both
 * live in a store an adapter owns and are handed in as `DispatchControlState`". This is
 * that store, as the dispatch job sees it.
 *
 * The port can *latch* the breaker and cannot clear either switch. That asymmetry is the
 * design, not an omission: D5's kill switch is "one command" a human runs, and the breaker
 * is closed "by hand after inspection" (05 §5.2.3; A1.5 for the ingest leg). A dispatcher
 * that could clear a switch through the same handle it reads with would be one bug away
 * from reopening the storm it stopped.
 *
 * `read` rejecting is a halt, not a default: an unreadable switch is not an open one, and
 * the job treats the rejection as a failed cycle that claims nothing.
 */

import type { DispatchControlState } from '../alerts/dispatch-breaker.js';

export interface DispatchControlStore {
  read(): Promise<DispatchControlState>;
  /**
   * Persist a breaker trip so that a worker restart cannot forget it. Idempotent: a latch
   * that is already set keeps its first instant and detail, which is the one that matters
   * to the post-mortem.
   */
  latchBreaker(at: number, detail: string): Promise<void>;
}
