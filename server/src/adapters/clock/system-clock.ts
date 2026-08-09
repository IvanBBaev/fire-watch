import type { Clock, EpochMs } from '../../core/ports/clock.js';

/**
 * The only place in the codebase allowed to read the wall clock. Everything else takes
 * a `Clock` (ADR-002 D7 — reprocessing and replay discipline).
 */
export const systemClock: Clock = {
  now(): EpochMs {
    return Date.now();
  },
};
