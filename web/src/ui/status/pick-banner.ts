/**
 * The single-slot banner arbiter.
 *
 * GLOSSARY §3b, "One degraded slot": the stale banner occupies a single strict-priority
 * slot, two simultaneous banners is a visual-regression failure, and one late source is a
 * layers-panel dot — never a banner. This function is the one place that decides which
 * banner (if any) occupies the slot, so no caller can compose two.
 *
 * Priority (highest first):
 *
 * 1. `offline` — the feed is `dead`, or it is `degraded` and no full snapshot has ever
 *    been applied (the user is looking at nothing, which is the offline experience even
 *    if some transport is technically alive).
 * 2. `stale-sources` — §3b gives this one slot two independent triggers, and either fills
 *    it:
 *    - a freshness report is present and either its overall status is `critical`, or
 *      *every* monitored detection-source row is `warn`/`critical` (12 H6: lost
 *      observation capability, not one late feed). `sinceIso` is the freshest `lastDataAt`
 *      across the monitored rows, falling back to the last snapshot time;
 *    - the snapshot we are showing is itself past 2× the push cadence budget, whatever the
 *      report says or fails to say. `sinceIso` is that snapshot's `generated_at`.
 * 3. `null` — no banner.
 *
 * Deliberately conservative — a banner renders only when we are confident:
 * - `connecting` never banners (we do not know anything yet);
 * - a report with no monitored source rows never banners (the copy claims "satellite
 *   data delayed", which cannot be said honestly without a satellite-source row);
 * - rows in `muted`/`unknown` states do not count as degraded;
 * - no banner without an honest "since" instant, and never one in the future of
 *   server time (clock skew / garbage data).
 *
 * Pure: state in, verdict out. `serverNowMs` comes from `serverNow()` (core/ports.ts).
 */

import { MONITORED_SOURCE_IDS, SNAPSHOT_PUSH_WARN_SECONDS } from '@fire-watch/contracts';
import type { FreshnessReport, FreshnessRow } from '@fire-watch/contracts';
import type { StoreState } from '../../core/types.js';

export type Banner =
  { readonly kind: 'offline' } | { readonly kind: 'stale-sources'; readonly sinceIso: string };

const MONITORED: ReadonlySet<string> = new Set<string>(MONITORED_SOURCE_IDS);

/**
 * §3b trigger 1, "past 2× cadence budget". The budget doubled is the snapshot-push *warn*
 * threshold, not its nominal one-minute cycle: doubling the cycle would banner on ordinary
 * poll jitter, while doubling the budget lands at ten minutes — after ADR-003's
 * five-minute promise is already broken, and before the pager's critical at fifteen.
 */
const SNAPSHOT_STALE_AFTER_MS = 2 * SNAPSHOT_PUSH_WARN_SECONDS * 1_000;

export function pickBanner(state: StoreState, serverNowMs: number): Banner | null {
  if (isOffline(state)) return { kind: 'offline' };
  if (state.freshness !== null) {
    const sinceIso = staleSince(state.freshness, state.lastSnapshotAt, serverNowMs);
    if (sinceIso !== null) return { kind: 'stale-sources', sinceIso };
  }
  const staleSnapshotIso = staleSnapshotSince(state.lastSnapshotAt, serverNowMs);
  if (staleSnapshotIso !== null) return { kind: 'stale-sources', sinceIso: staleSnapshotIso };
  return null;
}

function isOffline(state: StoreState): boolean {
  if (state.feedStatus === 'dead') return true;
  return state.feedStatus === 'degraded' && state.lastSnapshotAt === null;
}

function staleSince(
  report: FreshnessReport,
  lastSnapshotAt: string | null,
  serverNowMs: number,
): string | null {
  const monitoredRows = report.rows.filter((freshnessRow) => MONITORED.has(freshnessRow.row));
  if (monitoredRows.length === 0) return null;

  const critical = report.status === 'critical';
  const everyMonitoredDegraded = monitoredRows.every(
    (freshnessRow) => freshnessRow.state === 'warn' || freshnessRow.state === 'critical',
  );
  if (!critical && !everyMonitoredDegraded) return null;

  const sinceIso = freshestLastDataAt(monitoredRows) ?? lastSnapshotAt;
  if (sinceIso === null) return null;

  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs) || sinceMs > serverNowMs) return null;
  return sinceIso;
}

/**
 * The trigger that survives the pipeline being down: the newest snapshot we hold is older
 * than a working push would ever leave it.
 *
 * Deliberately independent of the freshness report, because a report travelling the same
 * broken path is exactly the case this catches — and it is the dangerous one. A feed that
 * errors renders `offline`; a feed that simply stops answering renders a perfectly normal
 * map of yesterday's fires, and silence there reads as "nothing is burning".
 */
function staleSnapshotSince(lastSnapshotAt: string | null, serverNowMs: number): string | null {
  if (lastSnapshotAt === null) return null;
  const snapshotMs = Date.parse(lastSnapshotAt);
  // Same honesty rule as the source branch: no verdict from garbage, and none from a stamp
  // in the future of server time.
  if (!Number.isFinite(snapshotMs) || snapshotMs > serverNowMs) return null;
  return serverNowMs - snapshotMs > SNAPSHOT_STALE_AFTER_MS ? lastSnapshotAt : null;
}

function freshestLastDataAt(rows: readonly FreshnessRow[]): string | null {
  let freshestMs = Number.NEGATIVE_INFINITY;
  let freshestIso: string | null = null;
  for (const freshnessRow of rows) {
    if (freshnessRow.lastDataAt === null) continue;
    const ms = Date.parse(freshnessRow.lastDataAt);
    if (Number.isFinite(ms) && ms > freshestMs) {
      freshestMs = ms;
      freshestIso = freshnessRow.lastDataAt;
    }
  }
  return freshestIso;
}
