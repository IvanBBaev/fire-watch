/**
 * Small time arithmetic for lifecycle copy parameters. `nowMs` is always the
 * server-corrected epoch supplied by the caller — never read a clock here.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Whole days elapsed between an earlier ISO instant and `nowMs`, floored, never
 * negative. Unparseable input answers 0 — the honest floor, since the copy this feeds
 * ("archived: no satellite detections for N days") must not overstate silence.
 */
export function wholeDaysBetween(nowMs: number, earlierIso: string): number {
  const earlierMs = Date.parse(earlierIso);
  if (!Number.isFinite(earlierMs)) {
    return 0;
  }
  const elapsedMs = nowMs - earlierMs;
  if (elapsedMs <= 0) {
    return 0;
  }
  return Math.floor(elapsedMs / MS_PER_DAY);
}
