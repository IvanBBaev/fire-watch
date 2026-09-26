/**
 * Pure selectors over the store's event state. They take the state (or the minimal
 * structural slice of it) and compute derived views; nothing here mutates, subscribes,
 * or reads a clock — staleness math belongs to the server-time module, not to selectors.
 */

import type { FireEvent, StoreState } from '../types.js';

/** The slice every selector actually needs — `StoreState` and `ReconcilerState` both fit. */
type EventSetView = Pick<StoreState, 'events'>;

/**
 * Merge chains are path-compressed server-side (ADR-002 I2), so any chain longer than a
 * hop or two is transient client-side skew between deltas; the bound exists so a
 * contract-violating payload can degrade a lookup, never hang the router.
 */
const MERGE_CHAIN_DEPTH_LIMIT = 16;

export interface ResolvedEvent {
  /** The event to show — the survivor when the requested id was merged away. */
  readonly event: FireEvent;
  /**
   * The public id the caller asked for, when it is not the id of `event` — i.e. the
   * permalink was a tombstone and the shell should `replaceState` to the canonical URL
   * (ADR-003 D4). `null` when the id resolved directly.
   */
  readonly resolvedFrom: string | null;
}

/** All events, most recently observed first — the list view's natural order. */
export function sortedEvents(state: EventSetView): readonly FireEvent[] {
  return [...state.events.values()].sort(compareByRecencyThenId);
}

/**
 * Resolve a public id to the event a permalink should land on, following `mergedInto`
 * chains so a tombstone resolves to its survivor — a shared link outlives the merge
 * (ADR-002 D3, I1). Bounded depth and cycle-safe: on a dangling pointer, a cycle, or an
 * over-long chain the walk settles on the deepest resolvable event rather than failing —
 * a slightly stale landing beats a broken permalink. Returns `null` only when the id is
 * unknown to the store entirely (the shell then falls back to the API, which answers for
 * archived events the snapshot no longer carries).
 */
export function resolveEvent(state: EventSetView, publicId: string): ResolvedEvent | null {
  // The store is keyed on the public id itself (schema v2), so no side index is needed.
  let event = state.events.get(publicId);
  if (event === undefined) return null;

  const seen = new Set<string>([event.id]);
  for (let depth = 0; depth < MERGE_CHAIN_DEPTH_LIMIT && event.mergedInto !== null; depth += 1) {
    const next = state.events.get(event.mergedInto);
    if (next === undefined || seen.has(next.id)) break;
    seen.add(next.id);
    event = next;
  }

  return { event, resolvedFrom: event.id === publicId ? null : publicId };
}

/**
 * The events the map renders. Two kinds of resident events are excluded, and stay
 * resident precisely *because* they are excluded here rather than removed from the store:
 *
 * - **`status: 'archived'`** — archived history has left the 48 h map display window
 *   (ADR-002 A1.3; the transition is written server-side by the lifecycle tick job, the
 *   client never applies a wall-clock filter of its own — ADR-003 A1.4/R1).
 * - **Tombstones (`mergedInto` set)** — a merged-away event renders only through its
 *   survivor; drawing both would show one fire twice (review 08 §5.2.4 rule 2: "the
 *   renderer drops it, the router uses it for redirects").
 *
 * Both keep resolving via {@link resolveEvent}, so no permalink 404s over a rendering
 * choice. Returned most recently observed first for deterministic `setData` payloads.
 */
export function visibleMapEvents(state: EventSetView): readonly FireEvent[] {
  return sortedEvents(state).filter(isVisibleOnMap);
}

function isVisibleOnMap(event: FireEvent): boolean {
  return event.status !== 'archived' && event.mergedInto === null;
}

function compareByRecencyThenId(a: FireEvent, b: FireEvent): number {
  const byRecency = observedAtMs(b) - observedAtMs(a);
  if (byRecency !== 0) return byRecency;
  // Public ids as the tiebreak keep the order total and stable across reconciles.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Timestamps are ISO-8601 UTC by contract (`types.ts`), but with and without fractional
 * seconds they do not compare lexicographically, so parse. A malformed value — the feed
 * adapter guards the wire, so this is belt-and-braces — sorts last rather than poisoning
 * the comparator with NaN.
 */
function observedAtMs(event: FireEvent): number {
  const ms = Date.parse(event.lastObservedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}
