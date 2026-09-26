/**
 * The shadow diff's read side (TASKS H8; 06 §5.7; GATES L-1).
 *
 * One call returns both sides of one window, already projected to the shapes
 * `core/shadow/shadow-diff.ts` compares, so the diff never learns what a table looks like
 * and the adapter never learns what a diff is. Everything the diff needs to be honest
 * about is the reader's to get right, and each rule is stated here so an adapter cannot
 * quietly pick another:
 *
 *   - **Which events are "in" the window.** An event whose detection span touches the
 *     half-open window — `last_detection_at >= from AND started_at < to` — plus any event
 *     an in-window alert names. The second clause is what keeps an alert on an event that
 *     went quiet the day before from turning up as a key the diff cannot resolve.
 *   - **Merge tombstones are included**, with `mergedInto` set. The diff excludes them from
 *     pairing and follows them for DAR; dropping them here would make both impossible.
 *   - **Live detection sets are the promoted ones.** `event_detections` holds membership
 *     per clustering run; the live side's set is the union over live runs and promoted
 *     offline runs, which is what the public map shows. An unpromoted offline run is
 *     itself a candidate and has no business on the live side.
 *   - **Live `manual` alerts are excluded.** A human-initiated send is not a rule outcome
 *     and no candidate could reproduce it; left in, it is an `alert_only_live` line that
 *     can only ever be "explained" by writing "it was manual" every night.
 *   - **Alerts are those decided in the window**, by `decided_at`. The shadow never
 *     dispatches, so decision time is the only instant both sides share.
 */

import type { ShadowSide, ShadowSideAlert, ShadowWindow } from '../shadow/shadow-diff.js';

export interface ShadowDiffWindowQuery {
  /** The candidate's `config_version`, as stamped on every shadow row. */
  readonly candidateVersion: string;
  readonly window: ShadowWindow;
}

export interface ShadowDiffReader {
  loadWindow(query: ShadowDiffWindowQuery): Promise<{
    readonly live: ShadowSide;
    readonly shadow: ShadowSide;
  }>;
}

/**
 * The beta "what you would have received" hook (07 §5.5.2; IP WP6): one zone's shadow
 * alerts over a window, oldest first, read-only.
 *
 * Deliberately a separate port. A route that renders it must be handed a reference that
 * provably cannot read another zone's rows, and the diff's reader reads every zone. The
 * route itself is not defined: its shape, its auth, and whether a candidate's own event
 * key may be shown to a user (it is not a public id — pairing it to one is the diff's job,
 * and nothing here does that) are open decisions.
 */
export interface WouldHaveReceivedReader {
  shadowAlertsForZone(query: {
    readonly zoneId: string;
    readonly candidateVersion: string;
    readonly window: ShadowWindow;
  }): Promise<readonly ShadowSideAlert[]>;
}
