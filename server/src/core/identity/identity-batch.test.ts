/**
 * The per-batch pieces the live identity pipeline shares with the replay engine.
 *
 * `identity-cycle.test.ts` proves the pieces compose into the replay's answer; this file
 * pins the pieces whose failure would be quiet there — a store round trip that loses a
 * member attribute, a working set whose id counter lags, and the alert-state netting of two
 * plans that both write `alert_states` in one transaction.
 */

import type { SourceId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { clusterBatch, emptyState } from '../clustering/engine.js';
import type {
  ClusterBatchResult,
  ClusteringDetection,
  ClusteringState,
} from '../clustering/types.js';
import { epochMsFromIso } from '../ports/clock.js';
import type { StoredCluster, StoredWorkingSet } from '../ports/clustering-store.js';
import { NO_ALIASES } from '../registry/alias-registry.js';
import type { AlertStateRow } from '../registry/alert-state.js';
import {
  clusterFromStored,
  involvedPublicIds,
  planRegistryWrites,
  stateFromStored,
} from './identity-batch.js';

const SOURCE: SourceId = 'firms:viirs:snpp';
const params = CLUSTERING_PARAMS.values;
const uid = (n: number): string => String(n).padStart(64, '0');

/** Every detection built here, so a stored member can carry its raw footprint back. */
const built = new Map<string, ClusteringDetection>();

function detection(n: number, availableAt: string, acq: string, lon: string): ClusteringDetection {
  const row: ClusteringDetection = {
    detectionUid: uid(n),
    source: SOURCE,
    availableAt: epochMsFromIso(availableAt),
    acqTsIso: acq,
    latCanonical: '41.86000',
    lonCanonical: lon,
    scanKm: n % 2 === 0 ? 0.39 : null,
    trackKm: n % 2 === 0 ? 0.36 : null,
  };
  built.set(row.detectionUid, row);
  return row;
}

function batch(
  state: ClusteringState,
  availableAt: string,
  detections: readonly ClusteringDetection[],
): ClusterBatchResult {
  return clusterBatch({
    detections,
    state,
    now: epochMsFromIso(availableAt),
    config: CLUSTERING_PARAMS,
  });
}

/** The working set as a store would hand it back: raw members, in reverse order. */
function stored(state: ClusteringState): StoredWorkingSet {
  const clusters: StoredCluster[] = state.clusters.map((cluster) => ({
    id: cluster.id,
    publicId: cluster.publicId,
    seedDetectionUid: cluster.seedDetectionUid,
    mintedAt: cluster.mintedAt,
    configVersion: cluster.configVersion,
    sourceRegistryVersion: cluster.sourceRegistryVersion,
    members: [...cluster.members].reverse().map((member) => ({
      detectionUid: member.detectionUid,
      source: member.source,
      acqTsIso: member.acqTsIso,
      latCanonical: member.latCanonical,
      lonCanonical: member.lonCanonical,
      scanKm: built.get(member.detectionUid)?.scanKm ?? null,
      trackKm: built.get(member.detectionUid)?.trackKm ?? null,
      frpMw: null,
    })),
  }));
  return {
    clusters: [...clusters].reverse(),
    nextClusterId: state.nextClusterId,
    takenPublicIds: [...state.takenPublicIds].reverse(),
  };
}

const T1 = '2026-08-05T03:10:00Z';
const T2 = '2026-08-05T15:10:00Z';

describe('stateFromStored', () => {
  const first = batch(emptyState(), T1, [
    detection(1, T1, '2026-08-05T00:06:00Z', '26.10000'),
    detection(2, T1, '2026-08-05T00:07:00Z', '26.10500'),
    detection(3, T1, '2026-08-05T00:06:00Z', '26.13000'),
  ]);

  it('reads back the working set the engine left, up to member order', () => {
    const back = stateFromStored(stored(first.state), params);
    expect(back.nextClusterId).toBe(first.state.nextClusterId);
    expect(back.takenPublicIds).toEqual([...first.state.takenPublicIds].sort());
    expect(back.clusters.map((c) => c.id)).toEqual(first.state.clusters.map((c) => c.id));
    for (const [i, cluster] of back.clusters.entries()) {
      const original = first.state.clusters[i];
      if (original === undefined) throw new Error('cluster count differs');
      const byUid = (a: { detectionUid: string }, b: { detectionUid: string }): number =>
        a.detectionUid < b.detectionUid ? -1 : 1;
      expect([...cluster.members].sort(byUid)).toEqual([...original.members].sort(byUid));
      expect(cluster.startedAt).toBe(original.startedAt);
      expect(cluster.lastDetectionAt).toBe(original.lastDetectionAt);
      expect(cluster.mintedAt).toBe(original.mintedAt);
    }
  });

  it('clusters the next batch the same from the stored set as from the in-memory one', () => {
    const next = [detection(4, T2, '2026-08-05T12:06:00Z', '26.11500')];
    const fromMemory = batch(first.state, T2, next);
    const fromStore = batch(stateFromStored(stored(first.state), params), T2, next);
    expect(fromStore.assignments).toEqual(fromMemory.assignments);
    expect(fromStore.merges).toEqual(fromMemory.merges);
    expect(fromStore.stats).toEqual(fromMemory.stats);
  });

  it('refuses a counter that does not exceed every live id', () => {
    const set = stored(first.state);
    expect(() => stateFromStored({ ...set, nextClusterId: 2 }, params)).toThrow(RangeError);
  });

  it('refuses a cluster row without members', () => {
    const [cluster] = stored(first.state).clusters;
    if (cluster === undefined) throw new Error('no cluster');
    expect(() => clusterFromStored({ ...cluster, members: [] }, params)).toThrow(/no members/);
  });
});

describe('planRegistryWrites', () => {
  const first = batch(emptyState(), T1, [detection(1, T1, '2026-08-05T00:06:00Z', '26.13000')]);
  // West of the older event and sorted before the bridge: seeded, then absorbed.
  const second = batch(first.state, T2, [
    detection(2, T2, '2026-08-05T12:06:00Z', '26.10000'),
    detection(3, T2, '2026-08-05T12:07:00Z', '26.11500'),
  ]);
  const older = first.seeded[0]?.publicId ?? '';
  const seed = second.seeded[0]?.publicId ?? '';

  it('mints an absorbed seed as a tombstone of its seed detection alone', () => {
    expect(second.merges).toHaveLength(1);
    const writes = planRegistryWrites({
      result: second,
      aliases: NO_ALIASES,
      candidates: [],
      alertStates: [],
      params,
      batchAtMs: epochMsFromIso(T2),
    });
    expect(writes.seededEvents).toHaveLength(1);
    expect(writes.seededEvents[0]).toMatchObject({
      absorbed: true,
      seedDetectionUid: uid(2),
      mintedAt: epochMsFromIso(T2),
      initial: { publicId: seed, detectionCount: 1, hull: [] },
    });
    expect(writes.merge.tombstones).toEqual([
      { publicId: seed, mergedIntoPublicId: older, bridgedByDetectionUid: uid(3) },
    ]);
    expect(writes.aggregates.map((a) => [a.publicId, a.detectionCount])).toEqual([[older, 3]]);
  });

  it('nets the merge migration into one delete set and one upsert set', () => {
    const row = (eventPublicId: string, watermark: number): AlertStateRow => ({
      zoneId: 'zone-a',
      eventPublicId,
      state: 'notified_new',
      escalationWatermark: watermark,
      seededAtIso: null,
      lastNotifiedAtIso: '2026-08-05T12:30:00Z',
    });
    const writes = planRegistryWrites({
      result: second,
      aliases: NO_ALIASES,
      candidates: [],
      // The absorbed seed cannot own a row yet; the survivor and an uninvolved event do.
      alertStates: [row(older, 1), row('fw-2026-zzzzz', 2)],
      params,
      batchAtMs: epochMsFromIso(T2),
    });
    expect(writes.alertStates.deletes).toEqual([]);
    expect(writes.alertStates.upserts.map((r) => r.eventPublicId)).toEqual([older]);
  });

  it("moves a loser's alert row onto the survivor: one delete, one upsert", () => {
    const two = batch(emptyState(), T1, [
      detection(11, T1, '2026-08-05T00:06:00Z', '26.10000'),
      detection(13, T1, '2026-08-05T00:06:00Z', '26.13000'),
    ]);
    const bridged = batch(two.state, T2, [detection(15, T2, '2026-08-05T12:06:00Z', '26.11500')]);
    const [merge] = bridged.merges;
    const loser = merge?.absorbedPublicIds[0];
    if (merge === undefined || loser === undefined) throw new Error('no merge');
    const writes = planRegistryWrites({
      result: bridged,
      aliases: NO_ALIASES,
      candidates: [],
      alertStates: [
        {
          zoneId: 'zone-a',
          eventPublicId: loser,
          state: 'notified_escalation',
          escalationWatermark: 2,
          seededAtIso: null,
          lastNotifiedAtIso: '2026-08-05T12:30:00Z',
        },
      ],
      params,
      batchAtMs: epochMsFromIso(T2),
    });
    expect(writes.alertStates.deletes).toEqual([{ zoneId: 'zone-a', eventPublicId: loser }]);
    expect(writes.alertStates.upserts).toMatchObject([
      {
        zoneId: 'zone-a',
        eventPublicId: merge.survivorPublicId,
        state: 'notified_escalation',
        escalationWatermark: 2,
      },
    ]);
  });

  it('names every event whose alert rows either plan could read', () => {
    expect(involvedPublicIds(second, NO_ALIASES, [], params)).toEqual([older, seed].sort());
  });
});
