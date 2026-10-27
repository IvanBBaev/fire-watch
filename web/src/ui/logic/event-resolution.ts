/**
 * Permalink resolution helpers (ADR-002 I1 on the client, review 08 §5.1.4).
 *
 * A merged event's public id keeps resolving — the store hands back the survivor — and
 * the URL must then be replaced (never pushed) with the survivor's canonical path so
 * copied links converge on one id.
 */

import type { FeedStatus } from '../../core/types.js';

export function eventPath(publicId: string): string {
  return `/event/${publicId}`;
}

/**
 * Where the event page must `replaceState` to, or `null` to stay put.
 *
 * Deliberately keyed on the *ids* rather than on the store's `resolvedFrom` marker:
 * whenever the event that will be rendered does not carry the id in the address bar
 * (tombstone hop, or a future chain of merges), the URL is stale and gets replaced.
 */
export function redirectTargetFor(
  requestedId: string,
  resolvedPublicId: string | null,
): string | null {
  if (resolvedPublicId === null || resolvedPublicId === requestedId) {
    return null;
  }
  return eventPath(resolvedPublicId);
}

/**
 * What an event page with no event to show is allowed to say.
 *
 * "Not found" is a claim about the data (this id is not in what the server publishes),
 * and it may be made only from data that could have held it. Before the first snapshot
 * is applied there is nothing to look in, so the page is still loading: a cold permalink
 * open must never flash "not found". A feed that has stopped answering, or a snapshot the
 * stale banner is already up for, cannot vouch for an absence either — the event may be
 * newer than what the client holds — so the page says it could not load the event, not
 * that the event does not exist.
 */
export type EventPageState = 'found' | 'loading' | 'unavailable' | 'not-found';

export interface EventPageInputs {
  /** The requested id (or its merge survivor) is in the store. */
  readonly found: boolean;
  /** `StoreState.lastSnapshotAt`: `null` until a full snapshot has been applied. */
  readonly lastSnapshotAt: string | null;
  readonly feedStatus: FeedStatus;
  /** `pickBanner` fills the degraded slot (offline or stale sources) at this instant. */
  readonly bannerUp: boolean;
}

export function eventPageState(inputs: EventPageInputs): EventPageState {
  if (inputs.found) return 'found';
  const failing = inputs.feedStatus === 'degraded' || inputs.feedStatus === 'dead';
  if (inputs.lastSnapshotAt === null) return failing ? 'unavailable' : 'loading';
  return failing || inputs.bannerUp ? 'unavailable' : 'not-found';
}
