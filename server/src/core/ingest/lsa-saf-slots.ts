/**
 * Which geostationary slots to ask for, and when.
 *
 * A polar poll asks "what is new since I last looked" and the provider answers. A
 * geostationary product does not work that way: SEVIRI repeats every 15 minutes on a fixed
 * grid, so every granule that will ever exist already has an address — its slot — and the
 * only question is which addresses we are behind on. That makes the planner a pure
 * function of the clock and of the last slot we settled, with no network in it at all, and
 * therefore the one part of the LSA SAF leg that is fully testable without credentials.
 *
 * Two facts shape it (DATA-SOURCES §A4):
 *
 * - **The repeat cycle is not the publication time.** LSA-502 has a 15-minute repeat and
 *   roughly 30 minutes of product latency, so the 11:15 slot is not there at 11:15. Asking
 *   early is not merely wasted — a 404 against a granule that is coming is indistinguishable
 *   from a 404 against one that never will, and it is the second that a gap should record.
 * - **GEO is attach-only** (ADR-002), E-weight 0.05 per slot, and never alerts on its own
 *   (ADR-004 D4). A slot that arrives late is worth much less than the next one on time —
 *   which is what makes the bounded catch-up below the right trade rather than a shortcut.
 */

import { epochMsFromIso, isoFromEpochMs, type EpochMs } from '../ports/clock.js';

export interface SlotCadence {
  /** Minutes between slots on the instrument's fixed repeat grid. */
  readonly repeatMinutes: number;
  /** Typical minutes between a slot's nominal time and the granule being published. */
  readonly latencyMinutes: number;
}

/** MSG SEVIRI FRP-PIXEL: operational, 15-minute repeat, ~30 minutes of product latency. */
export const LSA_502_CADENCE: SlotCadence = { repeatMinutes: 15, latencyMinutes: 30 };

/** MTG FCI FRP-PIXEL: demonstration maturity, 10-minute repeat. Never trusted alone. */
export const LSA_509_CADENCE: SlotCadence = { repeatMinutes: 10, latencyMinutes: 30 };

export interface SlotPlanRequest {
  readonly now: EpochMs;
  readonly cadence: SlotCadence;
  /**
   * The newest slot already settled — decoded, refused or recorded as missing. `null` is
   * a cold start, not an empty archive: history is the backfill's job, not the poller's.
   */
  readonly lastSettledSlotIso: string | null;
  /** How many slots one cycle may ask for. Bounds the work a long outage creates. */
  readonly maxSlots: number;
}

export interface SlotPlan {
  /** Slots to fetch this cycle, oldest first. */
  readonly slots: readonly string[];
  /**
   * Slots that were passed over because the backlog was longer than `maxSlots`. Named, not
   * silently dropped: a gap the archive cannot account for is worse than one it can.
   */
  readonly skipped: readonly string[];
}

const MINUTE_MS = 60_000;

/**
 * The newest slot that should exist by now — the last grid point at or before
 * `now - latency`. Everything after it is a granule the provider has not published yet.
 */
export function newestPublishedSlot(now: EpochMs, cadence: SlotCadence): string {
  const step = stepMs(cadence);
  const publishable = now - cadence.latencyMinutes * MINUTE_MS;
  return isoFromEpochMs(Math.floor(publishable / step) * step);
}

/**
 * Everything owed, oldest first, bounded.
 *
 * A cold start asks for exactly one slot. The alternative — walking back until the archive
 * looks full — turns every deploy into a backfill, and a backfill has its own task, its own
 * tier (`SP`) and its own rate budget.
 */
export function planGranuleSlots(request: SlotPlanRequest): SlotPlan {
  const { cadence, maxSlots } = request;
  if (!Number.isFinite(request.now)) {
    throw new RangeError(`now must be a finite epoch millisecond, got ${String(request.now)}`);
  }
  if (!Number.isInteger(maxSlots) || maxSlots < 1) {
    throw new RangeError(`maxSlots must be a positive integer, got ${String(maxSlots)}`);
  }

  const step = stepMs(cadence);
  const newest = epochMsFromIso(newestPublishedSlot(request.now, cadence));
  if (request.lastSettledSlotIso === null) {
    return { slots: [isoFromEpochMs(newest)], skipped: [] };
  }

  const last = epochMsFromIso(request.lastSettledSlotIso);
  if (last % step !== 0) {
    throw new RangeError(
      `last settled slot ${JSON.stringify(request.lastSettledSlotIso)} is not on the ` +
        `${String(cadence.repeatMinutes)}-minute grid`,
    );
  }
  // A slot already settled, or a clock that went backwards — either way there is nothing
  // to ask for, and asking anyway would re-fetch a granule we have already judged.
  if (last >= newest) return { slots: [], skipped: [] };

  const owed: string[] = [];
  for (let slot = last + step; slot <= newest; slot += step) owed.push(isoFromEpochMs(slot));

  // When the backlog is longer than one cycle can carry, keep the *newest* slots. A
  // 15-minute cadence layer earns its keep by being current; an hour-old slot attaches
  // 0.05 of evidence to an event that has already been seen twice by other means.
  const overflow = Math.max(0, owed.length - maxSlots);
  return { slots: owed.slice(overflow), skipped: owed.slice(0, overflow) };
}

function stepMs(cadence: SlotCadence): number {
  const { repeatMinutes } = cadence;
  if (!Number.isInteger(repeatMinutes) || repeatMinutes < 1 || 60 % repeatMinutes !== 0) {
    throw new RangeError(
      `repeat must divide the hour to keep slots on a fixed grid, got ${String(repeatMinutes)}`,
    );
  }
  return repeatMinutes * MINUTE_MS;
}
