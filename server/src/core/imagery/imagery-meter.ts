/**
 * The imagery quota tripwire — ADR-001 A1.3 as amended by A2.3 (TASKS A17, G6).
 *
 * Esri World Imagery is reachable only through ArcGIS Location Platform: a free tier of
 * 2M tiles a month, metered, behind an API key (A1.3). A2.3 moves the decision about
 * whether the fleet may use it to the server: `/api/client-config` carries an `imagery`
 * block only while imagery is enabled, a client renders the toggle only when the block is
 * present, and metered usage crossing a configured ceiling removes the block. The cliff is
 * therefore a missing control, never a broken layer.
 *
 * This module is the rule and nothing else. It reads no clock, no file and no provider; the
 * shell below is handed a `Clock` and an `ImageryMeterStore`, and `decideImagery` is a pure
 * function of what they returned, so every branch is a table test.
 *
 * **Hysteresis (A2.3).** A trip is latched for the quota period it happened in, and only
 * two things re-enable imagery: the next quota period, or an explicit ops override for the
 * current one. A usage reading that dips back under the ceiling — a provider correction, a
 * lagging meter, a file an operator edited — never does, because the latch, not the
 * reading, is the state.
 *
 * **Fail-closed.** Every doubt disables: no key configured, a store that cannot be read, no
 * usage reading for the current period. The alternative — imagery on while the meter is
 * blind — is exactly the uncapped spend the tripwire exists to prevent, and the cost of
 * being wrong the other way is a missing optional toggle.
 *
 * **Unarmed until a founder sets the ceiling.** A2.3 says the ceiling sits "below the free
 * tier with headroom for metering lag" and names no number. This module does not invent
 * one: with no ceiling configured the meter reports `unarmed` and imagery stays off, which
 * is the only state that cannot overspend while the decision is open.
 */

import type { ClientImageryBlock } from '@fire-watch/contracts';

import type { Clock, EpochMs } from '../ports/clock.js';
import type { ImageryMeterReading, ImageryMeterStore } from '../ports/imagery-meter-store.js';

/** A1.3: the ArcGIS Location Platform free tier, in basemap tiles per month. A fact of the provider, not a tunable. */
export const ARCGIS_FREE_TIER_TILES_PER_PERIOD = 2_000_000;

/**
 * The quota period an instant falls in, as `YYYY-MM` in UTC.
 *
 * ASSUMPTION (open founder decision): ArcGIS bills the free tier per calendar month, and
 * this anchors that month in UTC. If the account's billing period is anchored elsewhere
 * (a subscription day, a local time zone), this is the one function that changes.
 */
export function quotaPeriodOf(ms: EpochMs): string {
  if (!Number.isFinite(ms)) {
    throw new RangeError(`quota period needs a finite instant, got ${String(ms)}`);
  }
  return new Date(ms).toISOString().slice(0, 7);
}

const QUOTA_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isQuotaPeriod(value: unknown): value is string {
  return typeof value === 'string' && QUOTA_PERIOD.test(value);
}

export interface ImageryMeterConfig {
  /** The client handles, or `null` when no key is configured (imagery simply does not exist). */
  readonly handles: ClientImageryBlock | null;
  /**
   * Tiles per quota period at which imagery is switched off, strictly below the free tier.
   * `null` is the unarmed state (the founder decision is open) and keeps imagery off.
   */
  readonly ceilingTiles: number | null;
}

/** Why imagery is on or off right now. Exactly one reason; `enabled` and `override` are the on states. */
export type ImageryState =
  | 'enabled'
  | 'override'
  | 'no_key'
  | 'unarmed'
  | 'kill_switch'
  | 'tripped'
  | 'no_reading'
  | 'store_error';

export interface ImageryDecision {
  readonly state: ImageryState;
  readonly period: string;
  /** True only on the evaluation that found usage at or over the ceiling with no latch yet: the shell must latch it. */
  readonly trip: boolean;
  /** The current period's reading, when the store had one; carried for the log line. */
  readonly tiles: number | null;
}

export function isImageryEnabled(state: ImageryState): boolean {
  return state === 'enabled' || state === 'override';
}

export function assertImageryMeterConfig(config: ImageryMeterConfig): void {
  const { ceilingTiles } = config;
  if (ceilingTiles === null) return;
  if (
    !Number.isInteger(ceilingTiles) ||
    ceilingTiles < 1 ||
    ceilingTiles >= ARCGIS_FREE_TIER_TILES_PER_PERIOD
  ) {
    throw new RangeError(
      `imagery ceiling must be an integer in [1, ${String(ARCGIS_FREE_TIER_TILES_PER_PERIOD)}), got ${String(ceilingTiles)}`,
    );
  }
}

/**
 * The rule. Order matters and is the specification:
 *
 * 1. no key — imagery does not exist, nothing else is worth reading;
 * 2. unarmed — no ceiling, so no way to know the cliff is not already behind us;
 * 3. kill switch — ops said off, and nothing overrides that;
 * 4. override for this period — ops said on, deliberately, after looking; it outranks the
 *    latch (that is what it is for) and a missing reading (ops is the meter now);
 * 5. latched for this period — the hysteresis;
 * 6. no reading for this period — the meter is blind, so off;
 * 7. usage at or over the ceiling — off, and latch it;
 * 8. otherwise on.
 *
 * A reading for another period is no reading: last month's count says nothing about this
 * month, and a stale file must not keep imagery on after a rollover it did not see.
 */
export function decideImagery(
  reading: ImageryMeterReading,
  period: string,
  config: ImageryMeterConfig,
): ImageryDecision {
  const tiles = reading.usage?.period === period ? reading.usage.tiles : null;
  const decided = (state: ImageryState, trip = false): ImageryDecision => ({
    state,
    period,
    trip,
    tiles,
  });

  if (config.handles === null) return decided('no_key');
  if (config.ceilingTiles === null) return decided('unarmed');
  if (reading.killSwitch) return decided('kill_switch');
  if (reading.override) return decided('override');
  if (reading.tripped) return decided('tripped');
  if (tiles === null) return decided('no_reading');
  if (tiles >= config.ceilingTiles) return decided('tripped', true);
  return decided('enabled');
}

export interface ImageryTransition {
  readonly from: ImageryState;
  readonly to: ImageryState;
  readonly period: string;
  readonly tiles: number | null;
  /** True when this evaluation latched a trip (the alarm A2.3 says still fires). */
  readonly tripped: boolean;
  /** Set when the state is `store_error`: why the store could not be read. */
  readonly detail?: string;
}

export interface ImageryMeter {
  /**
   * Read the store once and decide. Resolves to the transition when the state changed and
   * `null` when it did not; never rejects — a store failure is the `store_error` state.
   */
  evaluate(): Promise<ImageryTransition | null>;
  /** The block to serve right now, or `undefined` when imagery is off. */
  block(): ClientImageryBlock | undefined;
  state(): ImageryState;
}

export interface ImageryMeterDeps {
  readonly clock: Clock;
  readonly config: ImageryMeterConfig;
  readonly store: ImageryMeterStore;
}

/**
 * The stateful shell: holds the last decision so the route reads a value, not a promise,
 * and latches a trip through the store. It starts off — a process that has not evaluated
 * yet has not seen a reading, and rule 6 says what that means.
 */
export function createImageryMeter(deps: ImageryMeterDeps): ImageryMeter {
  const { clock, config, store } = deps;
  assertImageryMeterConfig(config);
  let current: ImageryState = config.handles === null ? 'no_key' : 'no_reading';
  let inFlight: Promise<ImageryTransition | null> | null = null;

  async function run(): Promise<ImageryTransition | null> {
    const now = clock.now();
    const period = quotaPeriodOf(now);
    let decision: ImageryDecision;
    let detail: string | undefined;
    if (config.handles === null || config.ceilingTiles === null) {
      // Rules 1 and 2 need no store: an unconfigured meter never touches the disk.
      decision = decideImagery(EMPTY_READING, period, config);
    } else {
      try {
        decision = decideImagery(await store.read(period), period, config);
        if (decision.trip) {
          await store.latchTrip(
            period,
            now,
            `usage ${String(decision.tiles)} >= ceiling ${String(config.ceilingTiles)}`,
          );
        }
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
        decision = { state: 'store_error', period, trip: false, tiles: null };
      }
    }
    const from = current;
    current = decision.state;
    if (from === current && !decision.trip) return null;
    return {
      from,
      to: current,
      period,
      tiles: decision.tiles,
      tripped: decision.trip,
      ...(detail === undefined ? {} : { detail }),
    };
  }

  return {
    evaluate(): Promise<ImageryTransition | null> {
      // One evaluation at a time: a slow disk must not let two reads race a latch.
      inFlight ??= run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    block(): ClientImageryBlock | undefined {
      return config.handles !== null && isImageryEnabled(current) ? config.handles : undefined;
    },
    state(): ImageryState {
      return current;
    },
  };
}

const EMPTY_READING: ImageryMeterReading = {
  killSwitch: false,
  override: false,
  tripped: false,
  usage: null,
};
