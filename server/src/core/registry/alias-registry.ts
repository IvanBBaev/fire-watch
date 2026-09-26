/**
 * Merge tombstones and the alias table they form (ADR-002 D3, invariants I1 and I2).
 *
 * When two events turn out to be one fire, the loser is not deleted. It becomes a
 * tombstone — a row that still exists, still carries its `public_id`, and points at the
 * survivor through `merged_into`. That is the whole of I1: an id we have published resolves
 * forever, because someone screenshotted it, someone bookmarked it, and a 404 would read as
 * "that fire never happened" rather than "it turned out to be part of this one". The API
 * answers 200 with `mergedInto`, never 404 and never a bare redirect.
 *
 * I2 is the part that needs code rather than a schema: aliases must *converge*. Chains form
 * naturally — A is absorbed by B on Tuesday, B is absorbed by C on Wednesday — and a chain
 * that nobody flattens turns every lookup of A into a walk, and a chain that closes into a
 * loop turns it into a hang. So resolution here compresses as it goes (every node on the
 * path is rewritten to point straight at the end) and a revisited node is an immediate
 * throw naming the cycle. A cycle in this table is a bug in whatever wrote it; failing loud
 * at the read makes it a bug report, while looping makes it an outage.
 *
 * Keys are `public_id`s, not internal ids. I1 and I2 are promises about the ids we
 * published, the API resolves a `public_id`, and the storage adapter is where the
 * `fire_events.id` foreign key lives — putting internal ids here would mean the invariant
 * is stated in a vocabulary its own consumers do not speak.
 */

/** `public_id` → the `public_id` it was merged into. Tombstones only; survivors are absent. */
export type AliasLinks = ReadonlyMap<string, string>;

/** An empty table, for callers starting from nothing. */
export const NO_ALIASES: AliasLinks = new Map<string, string>();

/**
 * A tombstone whose `merged_into` moved during path compression. The old value is carried
 * so the write can be logged as what it is — a shortening of a chain, not a change of
 * outcome. Both pointers resolve to the same survivor; that is what makes the rewrite safe.
 */
export interface AliasRewrite {
  readonly publicId: string;
  readonly from: string;
  readonly to: string;
}

export interface AliasResolution {
  /** The live event. Equal to the input when the input is not a tombstone. */
  readonly canonical: string;
  /** Edges walked. `0` for a live event, `1` for an already-flat tombstone. */
  readonly hops: number;
  /** The compression this walk earned. Empty once the path is flat — the steady state. */
  readonly rewrites: readonly AliasRewrite[];
}

export class AliasCycleError extends RangeError {
  constructor(readonly cycle: readonly string[]) {
    super(`alias cycle: ${cycle.join(' -> ')}`);
    this.name = 'AliasCycleError';
  }
}

/**
 * Follows `publicId` to the live event it belongs to.
 *
 * Total by construction: an id that is not a key is its own canonical, so this answers for
 * ids the table has never heard of — which is the common case, since most lookups are of
 * live events. That totality is what lets the API call it unconditionally instead of
 * branching on "is this a tombstone".
 */
export function resolveAlias(links: AliasLinks, publicId: string): AliasResolution {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = publicId;

  for (;;) {
    const next = links.get(current);
    if (next === undefined) break;
    if (seen.has(next)) {
      throw new AliasCycleError([...path, current, next]);
    }
    seen.add(current);
    path.push(current);
    current = next;
  }

  const rewrites: AliasRewrite[] = [];
  for (const node of path) {
    const from = links.get(node);
    // `from` is defined for every node on the path; the guard is for the type, not the case.
    if (from !== undefined && from !== current) {
      rewrites.push({ publicId: node, from, to: current });
    }
  }
  return { canonical: current, hops: path.length, rewrites };
}

export function isTombstone(links: AliasLinks, publicId: string): boolean {
  return links.has(publicId);
}

/** A new table with the rewrites applied. Input untouched — every function here is pure. */
export function applyRewrites(links: AliasLinks, rewrites: readonly AliasRewrite[]): AliasLinks {
  if (rewrites.length === 0) return links;
  const next = new Map(links);
  for (const rewrite of rewrites) {
    next.set(rewrite.publicId, rewrite.to);
  }
  return next;
}

/**
 * Records that `tombstone` was absorbed by `survivor`.
 *
 * The survivor is resolved before the link is written, so the new row is flat *when it is
 * written*. It does not stay flat on its own: absorbing an event that other tombstones
 * already point at lengthens their rows by one hop, and that is what {@link compressAll} and
 * the compression {@link resolveAlias} earns on the read path are for. What this rule buys is
 * a bound — a chain grows only when its head is absorbed, never because a row was written
 * without looking.
 *
 * Three things are refused rather than tolerated, because each of them silently breaks I2
 * and each is cheap to detect here:
 *
 *   - a self-link, which the `fire_events_merged_into_not_self` constraint also refuses;
 *   - a link whose survivor resolves back to the tombstone, i.e. a cycle being created;
 *   - re-absorbing a tombstone into a *different* survivor. An event is absorbed once. Two
 *     merges claiming the same loser means the working set and the registry disagree about
 *     what is live, and picking a winner here would hide that behind a plausible answer.
 *
 * Re-absorbing into the *same* survivor is idempotent and allowed: that is a replay of a
 * merge that already happened (I4), and a replay must be silent.
 */
export function linkTombstone(
  links: AliasLinks,
  tombstone: string,
  survivor: string,
): { readonly links: AliasLinks; readonly rewrites: readonly AliasRewrite[] } {
  if (tombstone === survivor) {
    throw new RangeError(`an event cannot be merged into itself: ${tombstone}`);
  }

  const resolved = resolveAlias(links, survivor);
  if (resolved.canonical === tombstone) {
    throw new AliasCycleError([tombstone, survivor, resolved.canonical]);
  }

  const existing = links.get(tombstone);
  if (existing !== undefined) {
    const already = resolveAlias(links, existing);
    if (already.canonical !== resolved.canonical) {
      throw new RangeError(
        `${tombstone} is already merged into ${already.canonical}, cannot merge into ${resolved.canonical}`,
      );
    }
  }

  const rewrites = [...resolved.rewrites];
  if (existing !== undefined && existing !== resolved.canonical) {
    rewrites.push({ publicId: tombstone, from: existing, to: resolved.canonical });
  }

  const next = new Map(applyRewrites(links, rewrites));
  next.set(tombstone, resolved.canonical);
  return { links: next, rewrites };
}

/**
 * Flattens the whole table in one pass: every tombstone points straight at its live event.
 *
 * Amortised O(1) resolution is what I2 asks for and what {@link resolveAlias} already
 * delivers on the read path; this is the version for a caller that would rather pay once
 * and write the result, such as a merge transaction that is about to touch these rows
 * anyway. Throws on a cycle, like every other read here.
 */
export function compressAll(links: AliasLinks): AliasLinks {
  const flat = new Map<string, string>();
  for (const publicId of links.keys()) {
    flat.set(publicId, resolveAlias(links, publicId).canonical);
  }
  return flat;
}

/**
 * The rewrites that turn `before` into `after`, for keys `before` already had. New keys are
 * tombstones being created, which is an insert and not this function's business.
 * Ascending by `public_id`, so a plan built twice writes its updates in the same order.
 */
export function diffRewrites(before: AliasLinks, after: AliasLinks): readonly AliasRewrite[] {
  const rewrites: AliasRewrite[] = [];
  for (const [publicId, from] of before) {
    const to = after.get(publicId);
    if (to !== undefined && to !== from) {
      rewrites.push({ publicId, from, to });
    }
  }
  return rewrites.sort((a, b) => (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0));
}
