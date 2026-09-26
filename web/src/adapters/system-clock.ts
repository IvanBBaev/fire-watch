/**
 * The one place shipped web code may touch the real clock (eslint exempts
 * `src/adapters/`); everything else receives a `Clock`.
 */

import type { Clock } from '../core/ports.js';

export function createSystemClock(): Clock {
  return {
    epochNow: () => Date.now(),
    monotonicNow: () => performance.now(),
  };
}
