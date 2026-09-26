/**
 * Permalink resolution helpers (ADR-002 I1 on the client, review 08 §5.1.4).
 *
 * A merged event's public id keeps resolving — the store hands back the survivor — and
 * the URL must then be replaced (never pushed) with the survivor's canonical path so
 * copied links converge on one id.
 */

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
