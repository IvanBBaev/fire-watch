/**
 * Which cluster survives a merge (ADR-002 D3 rule 1).
 *
 * `min by (started_at, −detection_count, id)`: the oldest event wins, ties broken by the
 * larger one, then by the lowest internal id. The rule is here rather than inside the
 * clustering loop because D2 needs the identical ordering for the *registry* side of a
 * merge — tombstones, alias chains, `migrateAlertState` — and two implementations of
 * "oldest wins" would eventually disagree about a tie and leave the working set pointing
 * at one survivor while the event table points at another.
 *
 * Why oldest and not largest: the survivor keeps its `public_id`, and the id people have
 * already been given is the one attached to the fire they have been watching longest.
 */

import type { Cluster } from './types.js';

export function compareSurvivor(a: Cluster, b: Cluster): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  // −detection_count: the bigger cluster sorts first.
  if (a.members.length !== b.members.length) return b.members.length - a.members.length;
  return a.id - b.id;
}

/** The survivor of a merge. Total by construction — `id` is unique — so never ambiguous. */
export function chooseSurvivor(clusters: readonly Cluster[]): Cluster {
  if (clusters.length === 0) {
    throw new RangeError('a merge needs at least one cluster');
  }
  return [...clusters].sort(compareSurvivor)[0] as Cluster;
}
