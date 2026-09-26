/**
 * Scoping a list to what is *recent* — the time-axis peer of `core/geo/in-view.ts`.
 *
 * A satellite fire feed accumulates: an event stays resident until the server archives it,
 * so by the small hours of the second day a "current fires" list is mostly yesterday. The
 * window here is the reader's own answer to "how far back do I care?", applied to
 * `lastObservedAt` — satellite observation time (P1), never poll time.
 *
 * This is a **display filter, not a lifecycle judgement**. The client still never decides
 * that an event is over or archived (ADR-003 A1.4/R1) — that transition is written
 * server-side and arrives as `status`. Nothing here touches the store, and every hidden
 * row is counted out loud so the same rule the viewport filter obeys holds on this axis
 * too: the list may narrow, it may never silently shrink.
 *
 * `nowMs` is always passed in, and callers pass the feed's server-corrected clock
 * (ADR-003 A1.6) — a device clock an hour fast would otherwise hide live fires.
 */

const MS_PER_HOUR = 3_600_000;

/**
 * The offered windows, narrowest first. They are chosen against the satellite revisit
 * rate and the display window, not round numbers for their own sake:
 *
 * - **6 h** — roughly the last two or three polar passes: "what is burning now".
 * - **24 h** — a full day/night cycle, so a fire seen only on a night pass still shows.
 * - **48 h** — the whole map display window (ADR-002 A1.3); past it the server archives.
 * - **all** — no time bound at all, including anything resident beyond the window.
 *
 * Nothing shorter than 6 h is offered: with a ~4-passes-a-day sensor, a "last hour" view
 * would be empty most of the time and would read as "no fires" rather than "no new pass".
 */
export const AGE_WINDOW_IDS = ['6h', '24h', '48h', 'all'] as const;

export type AgeWindowId = (typeof AGE_WINDOW_IDS)[number];

/**
 * A day is the default: long enough to survive the gap between passes, short enough that
 * the list answers "what is happening" rather than "what happened this week".
 */
export const DEFAULT_AGE_WINDOW: AgeWindowId = '24h';

/** Remembered across visits — a reader who narrowed the window meant it. */
export const AGE_WINDOW_STORAGE_KEY = 'fw.age-window';

/** Hours of look-back per window; `null` is "no bound", not "zero hours". */
const WINDOW_HOURS: Readonly<Record<AgeWindowId, number | null>> = {
  '6h': 6,
  '24h': 24,
  '48h': 48,
  all: null,
};

export function ageWindowHours(id: AgeWindowId): number | null {
  return WINDOW_HOURS[id];
}

/**
 * The instant an event must have been observed at or after to survive the window, or
 * `null` when the window is unbounded. Absolute rather than relative so map and list can
 * be handed the same number and cannot disagree about where "now" is.
 */
export function ageCutoffMs(nowMs: number, id: AgeWindowId): number | null {
  const hours = WINDOW_HOURS[id];
  return hours === null ? null : nowMs - hours * MS_PER_HOUR;
}

export interface Observed {
  /** ISO-8601 UTC by contract (`core/types.ts`). */
  readonly lastObservedAt: string;
}

/**
 * An unparseable stamp counts as *not* recent. The feed adapter guards the wire, so this
 * is belt-and-braces — but the honest failure is to leave a row out of a window we cannot
 * prove it belongs in, and the caller still reports it in the hidden count.
 */
export function isWithinCutoff(item: Observed, cutoffMs: number | null): boolean {
  if (cutoffMs === null) return true;
  const observedMs = Date.parse(item.lastObservedAt);
  return Number.isFinite(observedMs) && observedMs >= cutoffMs;
}

export interface AgePartition<T> {
  /** Observed at or after the cutoff, in the caller's order. */
  readonly recent: readonly T[];
  /** How many the window leaves out — the number the "N older" row shows. */
  readonly olderCount: number;
}

/**
 * Split by the cutoff, preserving input order so an already recency-sorted list stays
 * sorted and a later viewport pass can re-order the survivors on its own terms.
 */
export function partitionByAge<T extends Observed>(
  items: readonly T[],
  cutoffMs: number | null,
): AgePartition<T> {
  if (cutoffMs === null) return { recent: items, olderCount: 0 };
  const recent = items.filter((item) => isWithinCutoff(item, cutoffMs));
  return { recent, olderCount: items.length - recent.length };
}

/** Storage/round-trip guard: anything not an offered window id answers `null`. */
export function parseAgeWindow(raw: string | null): AgeWindowId | null {
  if (raw === null) return null;
  return (AGE_WINDOW_IDS as readonly string[]).includes(raw) ? (raw as AgeWindowId) : null;
}
