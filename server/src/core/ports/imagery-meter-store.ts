/**
 * Where the imagery tripwire's state lives (ADR-001 A2.3; `core/imagery/imagery-meter.ts`).
 *
 * Four facts, all scoped by quota period where a period makes sense: an ops kill switch,
 * an ops override for the current period, the trip latch for the current period, and the
 * latest usage reading. The meter holds the rule; this port holds the state, so a process
 * restart cannot forget a trip.
 *
 * As with the dispatch control store, the port can *latch* and cannot clear. Re-enabling
 * inside a period is an ops act (A2.3 "explicit ops override"), and a meter that could
 * clear its own latch would be one bug away from the usage-dip re-enable A2.3 forbids.
 *
 * `read` rejecting is not a default: the meter maps it to `store_error`, which is off.
 */

export interface ImageryUsage {
  /** The quota period the count belongs to, `YYYY-MM`. */
  readonly period: string;
  /** Tiles consumed in that period so far, a non-negative integer. */
  readonly tiles: number;
}

export interface ImageryMeterReading {
  readonly killSwitch: boolean;
  /** An ops override exists for the period that was read. */
  readonly override: boolean;
  /** The trip latch exists for the period that was read. */
  readonly tripped: boolean;
  /** The latest usage reading, for whatever period it covers; `null` when there is none. */
  readonly usage: ImageryUsage | null;
}

export interface ImageryMeterStore {
  read(period: string): Promise<ImageryMeterReading>;
  /**
   * Persist a trip for `period`. Idempotent: a latch that already exists keeps its first
   * instant and detail.
   */
  latchTrip(period: string, at: number, detail: string): Promise<void>;
}
