/**
 * Replays one season through the production clustering engine under one config and
 * returns the final partition (TASKS D7).
 *
 * The fit runs `clusterBatch` itself — the same function the live worker, the SP
 * promotion and the golden replay run — rather than 11 §4.3's offline
 * `ST_ClusterDBSCAN`. A parameter fitted on a different algorithm is a parameter for a
 * different algorithm: DBSCAN is order-free and has no attach-only rule, no active window
 * and no T_LINK chain, and the numbers it would produce would not transfer.
 *
 * Batching. SP rows have no `available_at` (`fit-params.ts`, `replayBatchMinutes`): rows
 * are grouped into fixed windows over `acq_ts`, every row in a window made available at
 * the window's end, and the batch instant is that end. Empty windows are skipped — the
 * engine evicts against the next batch's instant, which is all an empty batch would do.
 *
 * Partition. A detection's event is the cluster it was assigned to, followed through
 * every later merge (union-find over cluster ids). GEO rows that attached nowhere are in
 * no event (`NO_EVENT`): A1.5 makes a GEO-only event impossible, and the metrics treat
 * such a row as separated from everything.
 */

import type { ClusteringParams } from '../clustering/clustering-params.js';
import { clusterBatch, emptyState } from '../clustering/engine.js';
import type { ClusteringDetection, ClusteringState } from '../clustering/types.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { SeasonFrame } from './season-frame.js';

export const NO_EVENT = -1;

export interface SeasonPartition {
  /** Per frame detection: its final event id, or {@link NO_EVENT}. */
  readonly eventOf: readonly number[];
  /** Earliest member `acq_ts` per event id — the event's `started_at`. */
  readonly startedAt: ReadonlyMap<number, number>;
  /** Distinct events over every detection, labelled or not (event-count stability). */
  readonly eventCount: number;
}

export function replaySeason(
  frame: SeasonFrame,
  config: VersionedConfig<ClusteringParams>,
  batchMinutes: number,
): SeasonPartition {
  const batchMs = batchMinutes * 60_000;
  const indexOfUid = new Map<string, number>();
  frame.detections.forEach((d, i) => indexOfUid.set(d.detectionUid, i));
  const clusterOf: number[] = frame.detections.map(() => NO_EVENT);
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) as number;
    let node = id;
    while (node !== root) {
      const next = parent.get(node) as number;
      parent.set(node, root);
      node = next;
    }
    return root;
  };

  let state: ClusteringState = emptyState();
  let start = 0;
  while (start < frame.detections.length) {
    const window = Math.floor((frame.acqMs[start] as number) / batchMs);
    let end = start;
    while (
      end < frame.detections.length &&
      Math.floor((frame.acqMs[end] as number) / batchMs) === window
    ) {
      end += 1;
    }
    const now = (window + 1) * batchMs;
    const batch: ClusteringDetection[] = frame.detections.slice(start, end).map((d) => ({
      ...d,
      availableAt: now,
    }));
    const result = clusterBatch({ detections: batch, state, now, config });
    for (const assignment of result.assignments) {
      const i = indexOfUid.get(assignment.detectionUid);
      if (i !== undefined) clusterOf[i] = assignment.clusterId;
      if (!parent.has(assignment.clusterId)) parent.set(assignment.clusterId, assignment.clusterId);
    }
    for (const merge of result.merges) {
      const survivor = find(merge.survivorClusterId);
      for (const absorbed of merge.absorbedClusterIds) {
        const root = find(absorbed);
        if (root !== survivor) parent.set(root, survivor);
      }
    }
    state = result.state;
    start = end;
  }

  const eventOf = clusterOf.map((c) => (c === NO_EVENT ? NO_EVENT : find(c)));
  const startedAt = new Map<number, number>();
  eventOf.forEach((e, i) => {
    if (e === NO_EVENT) return;
    const ms = frame.acqMs[i] as number;
    const current = startedAt.get(e);
    if (current === undefined || ms < current) startedAt.set(e, ms);
  });
  return { eventOf, startedAt, eventCount: startedAt.size };
}
