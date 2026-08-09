/**
 * The real pause: `node:timers/promises` rather than a hand-rolled `setTimeout` wrapper,
 * because it clears the timer when the signal aborts. A leaked timer keeps the event loop
 * alive, and a worker that will not exit on SIGTERM is a worker the supervisor kills
 * mid-write.
 */

import { setTimeout as delay } from 'node:timers/promises';

import type { Sleeper } from '../../core/ports/sleeper.js';

export const systemSleeper: Sleeper = {
  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    try {
      await delay(ms, undefined, { signal });
    } catch {
      // An aborted pause is the ordinary shutdown path, not a failure: the port promises
      // to return early, and the caller checks the signal itself.
    }
  },
};
