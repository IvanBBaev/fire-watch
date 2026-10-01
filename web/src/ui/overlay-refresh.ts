/**
 * Re-validate a daily overlay when the day it is for is over (TASKS F11).
 *
 * The FWI copy says which UTC day it is for (`x-fire-watch-overlay-valid-for`). A page
 * left open overnight used to keep yesterday's raster for as long as it stayed open — the
 * loader only fetched when the reader switched the layer on — so the panel ended up
 * saying "not today" over a map that could have had today's copy hours ago.
 *
 * **When.** The day ends at the next UTC midnight *by the server-corrected clock*
 * (`ServerNow`, ADR-003 A1.6), never the device's: a laptop an hour fast would otherwise
 * ask for a copy that cannot exist yet. After that, the proxy may still serve yesterday's
 * copy until the worker's next EFFIS refresh (every 6 h), so a copy that is still out of
 * date is asked for again every {@link ROLLOVER_RETRY_MS}, measured on the monotonic
 * clock from when it arrived. A copy that is current waits for its own midnight.
 *
 * **How long to sleep.** Never more than {@link MAX_CHECK_INTERVAL_MS} at a time: a
 * suspended laptop's timers do not advance while it sleeps, and the server clock can be
 * corrected underneath a long timer. Each wake-up recomputes from the clocks and fetches
 * only when the copy is actually due, so an early wake is a no-op, not a request.
 *
 * **Wind (F14).** The proxy serves the recorded forecast step whose valid time is nearest
 * its clock, so the step on screen goes out of date as time moves on — the loader used to
 * keep it until the reader toggled the layer. A wind copy carries the step's `validAt`:
 * it waits for that instant by the server clock, then asks every
 * {@link WIND_STEP_RETRY_MS} from the copy's arrival until the proxy hands over a later
 * step (the next becomes nearest halfway between the two, or a newer run lands). The
 * schedule never guesses the step spacing; it only asks, cheaply (the proxy's edge TTL is
 * 10 min and an unchanged body is a 304 upstream).
 *
 * **Lightning (F18).** The same step schedule with the copy's own `retryAfterMs`: its
 * `validAt` is the end of the newest product merged, always past, so the copy is asked for
 * again five minutes after each arrival (products land every 10 min).
 *
 * Only a `ready` copy with a `validFor` (or a wind or swaths `validAt`) is scheduled. A "latest"
 * layer (burnt areas) has no day to roll over, and an unavailable one is not retried here: the reader switching it
 * on again is what asks (`startOverlaySync`), and a build without a server (fixtures, e2e)
 * must not start polling a proxy that is not there.
 */

import { effect } from '@preact/signals';

import type { ServerNow } from '../core/ports.js';
import type { OverlayId, OverlayLoaderDeps, OverlayStatus } from './layers.js';
import { chosenOverlays, loadOverlay, overlayStatus } from './layers.js';

const DAY_MS = 86_400_000;

/** How soon an out-of-date copy is asked for again; the proxy's own edge TTL is 10 min. */
export const ROLLOVER_RETRY_MS = 30 * 60 * 1000;

/**
 * How often a wind step whose valid time has passed is asked for again. Steps are 6 h
 * apart, so the proxy's choice changes about 3 h after the shown step's valid time: six
 * asks, at most, per step.
 */
export const WIND_STEP_RETRY_MS = 30 * 60 * 1000;

/** The longest single sleep (see the module note on suspended timers). */
export const MAX_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type RevalidationPlan =
  /** Nothing to schedule. */
  | { readonly kind: 'none' }
  /** Fetch now. */
  | { readonly kind: 'due' }
  /** Look again in this many milliseconds (≤ {@link MAX_CHECK_INTERVAL_MS}). */
  | { readonly kind: 'wait'; readonly ms: number };

/** The instant (server epoch ms) the UTC day `validFor` ends; `null` if it is not a date. */
export function validForEndsAtMs(validFor: string): number | null {
  const start = Date.parse(`${validFor}T00:00:00Z`);
  return Number.isFinite(start) ? start + DAY_MS : null;
}

/**
 * What to do about one overlay's copy. Pure: `serverNowMs` is the server-corrected epoch,
 * `monotonicNowMs` the clock `fetchedAtMs` was read from.
 */
export function planRevalidation(
  status: OverlayStatus,
  serverNowMs: number,
  monotonicNowMs: number,
): RevalidationPlan {
  if (status.kind !== 'ready') return { kind: 'none' };
  if (status.validFor === null) {
    return status.validAt === undefined
      ? { kind: 'none' }
      : planStepRevalidation(
          status.validAt,
          status.fetchedAtMs,
          serverNowMs,
          monotonicNowMs,
          status.retryAfterMs,
        );
  }
  const endsAt = validForEndsAtMs(status.validFor);
  if (endsAt === null) return { kind: 'none' };
  const untilRollover = endsAt - serverNowMs;
  const untilRetry = status.fetchedAtMs + ROLLOVER_RETRY_MS - monotonicNowMs;
  // Still the copy's own day: wait for midnight. Past it: retry on the cadence, counted
  // from when this copy arrived, so a copy fetched just after midnight is not re-asked.
  const wait = untilRollover > 0 ? untilRollover : untilRetry;
  if (wait <= 0) return { kind: 'due' };
  return { kind: 'wait', ms: Math.min(wait, MAX_CHECK_INTERVAL_MS) };
}

/**
 * The wind half of {@link planRevalidation}: wait for the shown step's valid instant by the
 * server clock, then retry on {@link WIND_STEP_RETRY_MS} counted from the copy's arrival —
 * so a copy fetched after that instant is not re-asked at once. Pure.
 */
export function planStepRevalidation(
  validAt: string,
  fetchedAtMs: number,
  serverNowMs: number,
  monotonicNowMs: number,
  /** The copy's own retry cadence (lightning, F18); wind's by default. */
  retryMs: number = WIND_STEP_RETRY_MS,
): RevalidationPlan {
  const validAtMs = Date.parse(validAt);
  if (!Number.isFinite(validAtMs)) return { kind: 'none' };
  const untilValid = validAtMs - serverNowMs;
  const untilRetry = fetchedAtMs + retryMs - monotonicNowMs;
  const wait = untilValid > 0 ? untilValid : untilRetry;
  if (wait <= 0) return { kind: 'due' };
  return { kind: 'wait', ms: Math.min(wait, MAX_CHECK_INTERVAL_MS) };
}

export interface RevalidationDeps {
  readonly serverNow: ServerNow;
  readonly loader: OverlayLoaderDeps;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

/**
 * Keep every chosen daily overlay current for the page's lifetime. Returns the disposer.
 * One timer per overlay, re-planned whenever its status or the choice changes.
 */
export function startOverlayRevalidation(deps: RevalidationDeps): () => void {
  const timers = new Map<OverlayId, unknown>();
  const clear = (id: OverlayId): void => {
    const handle = timers.get(id);
    if (handle !== undefined) deps.clearTimeout(handle);
    timers.delete(id);
  };

  const plan = (id: OverlayId): void => {
    clear(id);
    const next = planRevalidation(overlayStatus.peek()[id], deps.serverNow(), deps.loader.now());
    if (next.kind === 'due') {
      void loadOverlay(id, deps.loader);
    } else if (next.kind === 'wait') {
      timers.set(
        id,
        deps.setTimeout(() => {
          timers.delete(id);
          if (chosenOverlays.peek().includes(id)) plan(id);
        }, next.ms),
      );
    }
  };

  const stopEffect = effect(() => {
    const chosen = chosenOverlays.value;
    const statuses = overlayStatus.value;
    for (const id of Object.keys(statuses) as OverlayId[]) {
      if (chosen.includes(id)) plan(id);
      else clear(id);
    }
  });

  return () => {
    stopEffect();
    for (const id of [...timers.keys()]) clear(id);
  };
}
