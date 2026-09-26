/**
 * Where a meta-alert page goes (TASKS J1; OPERATIONS §3).
 *
 * Called once per **successful** monitor cycle with the full set of paging keys — a level,
 * not an edge. The adapter turns "nothing paging" into a success ping and "something
 * paging" into an explicit failure, so the same check is also a dead-man's switch on the
 * monitor loop itself: a loop that stops running stops pinging, and that pages too.
 *
 * Same two rules as {@link Heartbeat}: never called from a `finally`, and never throws — a
 * pager that cannot reach its provider swallows the error, because silence is already
 * the page from the other side.
 */

import type { MetaAlertKey } from '../monitoring/meta-alert-params.js';

export interface MetaAlertPager {
  report(paging: readonly MetaAlertKey[]): Promise<void>;
}

/** For a deployment with no meta-alert check configured. An explicit choice, like `noopHeartbeat`. */
export const noopMetaAlertPager: MetaAlertPager = {
  report(): Promise<void> {
    return Promise.resolve();
  },
};
