/**
 * The live identity cycle against an in-memory store (TASKS D1/D4 wiring).
 *
 * Two kinds of test, and the first kind is the reason the file exists:
 *
 *   - **Parity with the golden replay.** The same polls go through `runReplay` with the
 *     identity engine and through `runIdentityCycle` over {@link FakeStore}, one cycle per
 *     poll with the clock at the poll's instant — exactly how the replay advances its own
 *     clock. The registry each side ends with (public ids, tombstones, relations, member
 *     sets, lifecycle status and tier) must be the same. That is what "the live pipeline
 *     runs the code CI-1 proves" means as an assertion rather than as a claim, and it holds
 *     only because both sides share `identity-batch.ts` and the store round trip loses
 *     nothing the engine reads.
 *   - **The cycle's own bookkeeping**: the ledger skip, rollback on failure, the batch
 *     limit, the tick window, curated states, and writing a transition only on a change.
 *
 * The fake is a model of the Postgres adapter's contract, not of its SQL: it keeps the
 * working set as `clusters` rows whose members are the event's detections, allocates its
 * own ids for new clusters in the order it is handed them (as an IDENTITY column would),
 * and snapshots itself around a batch so a throwing batch leaves nothing behind.
 */

import {
  STATIC_SOURCE_FORMAT,
  STATIC_SOURCE_KINDS,
  parseStaticSourceMask,
  scoreBucket,
  type LifecycleState,
  type SourceId,
} from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { parseCanonicalDegrees } from '../clustering/geometry.js';
import type { ClusteringConfig, ClusteringDetection } from '../clustering/types.js';
import type { DisplayTier, GeoWeightSpent } from '../lifecycle/types.js';
import { staticPassPredictor } from '../lifecycle/static-pass-predictor.js';
import { VirtualClock, epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type {
  BatchTransaction,
  BatchWrite,
  ClusteringRun,
  ClusteringStore,
  EventScore,
  PendingBatch,
  PendingBatchQuery,
  StoredCarry,
  StoredCluster,
  StoredMember,
  StaticSourceStamp,
  StoredTickEvent,
  TickTransaction,
} from '../ports/clustering-store.js';
import type { EventStatusTransition } from '../ports/event-status-store.js';
import type { ReignitionCandidateEvent, ReignitionQuery } from '../ports/reignition-reader.js';
import type { AlertStateRow } from '../registry/alert-state.js';
import { resolveAlias } from '../registry/alias-registry.js';
import {
  EMPTY_OBSERVATIONS,
  parseFixtureManifest,
  parseReplayBatch,
} from '../replay/fixture-format.js';
import { identityEngine } from '../replay/identity-engine.js';
import { runReplay, type ReplayEvent } from '../replay/runner.js';
import type { ScoringDetection } from '../scoring/features.js';
import { scoreEvent } from '../scoring/score.js';
import {
  STATIC_SOURCE_POLICY,
  staticSourceEvaluator,
  type StaticSourceEvaluator,
} from '../static-sources/static-source-policy.js';
import { LIVE_SCORE_CONTEXT } from './event-scores.js';
import { MAX_TICK_WINDOW_MS, runIdentityCycle, tickWindowStart } from './identity-cycle.js';

const SOURCE: SourceId = 'firms:viirs:snpp';
const uid = (n: number): string => String(n).padStart(64, '0');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface DetectionSpec {
  readonly n: number;
  readonly acq: string;
  readonly lat?: string;
  readonly lon: string;
  /** Night unless said otherwise — the static-source quarantine reads it. */
  readonly dayNight?: 'D' | 'N';
}

interface PollSpec {
  readonly availableAt: string;
  readonly detections: readonly DetectionSpec[];
}

// ── the fake store ─────────────────────────────────────────────────────────────

interface FakeEvent {
  publicId: string;
  clusterId: number | null;
  status: LifecycleState;
  displayTier: DisplayTier;
  inactiveSinceMs: EpochMs | null;
  missEvidence: number;
  geoWeightSpent: GeoWeightSpent | null;
  blindSinceMs: EpochMs | null;
  seenDetectionAtMs: EpochMs | null;
  mergedInto: string | null;
  relation: { publicId: string; kind: string } | null;
  centroidLat: string;
  centroidLon: string;
  startedAtIso: string;
  lastDetectionAtIso: string;
  members: Set<string>;
  /** `null` until the first batch that rewrites this event's aggregates scores it. */
  score: number | null;
  scoreParamsVersion: string | null;
  invalidated: boolean;
  invalidatedReason: string | null;
  staticSource: StaticSourceStamp | null;
  seq: number;
}

/**
 * The SQL's `STICKY_INVALIDATION`: curation's invalidations stay, the two static-source
 * reasons follow the latest verdict.
 */
function stickyInvalidation(event: FakeEvent): boolean {
  return (
    event.invalidated &&
    event.invalidatedReason !== 'static_source' &&
    event.invalidatedReason !== 'suspected_static_source'
  );
}

/** The SQL's `STATIC_SOURCE_INVALIDATION` rule, verbatim. */
function applyVerdict(event: FakeEvent, score: EventScore): void {
  if (!stickyInvalidation(event)) {
    if (score.invalidated) {
      event.invalidated = true;
      event.invalidatedReason = score.invalidatedReason;
    } else if (event.invalidated) {
      event.invalidated = false;
      event.invalidatedReason = null;
    }
  }
  event.staticSource = score.staticSource;
}

interface FakeClusterRow {
  id: number;
  publicId: string;
  seedDetectionUid: string;
  mintedAt: EpochMs;
  configVersion: string;
  sourceRegistryVersion: string;
}

interface FakeRow {
  readonly detection: ClusteringDetection;
  readonly frpMw: number | null;
  readonly dayNight: 'D' | 'N';
}

interface FakeState {
  rows: Map<string, FakeRow>;
  ingestBatches: PendingBatch[];
  ledger: Set<string>;
  run: ClusteringRun | null;
  clusters: Map<number, FakeClusterRow>;
  events: Map<string, FakeEvent>;
  alertStates: Map<string, AlertStateRow>;
  nextId: number;
  seq: number;
  transitions: EventStatusTransition[];
}

/**
 * Every fake store method yields once before answering, as the Postgres store does: an
 * ordering bug that only holds when a store call completes synchronously cannot hide here.
 */
const yieldTurn = (): Promise<void> => Promise.resolve();

const batchKey = (batch: PendingBatch): string => `${String(batch.availableAt)}|${batch.source}`;
const alertKey = (row: { zoneId: string; eventPublicId: string }): string =>
  `${row.zoneId}|${row.eventPublicId}`;

class FakeStore implements ClusteringStore {
  state: FakeState = {
    rows: new Map(),
    ingestBatches: [],
    ledger: new Set(),
    run: null,
    clusters: new Map(),
    events: new Map(),
    alertStates: new Map(),
    nextId: 1,
    seq: 0,
    transitions: [],
  };
  /** Set to make the next `applyBatch` throw after it has written half the batch. */
  failNextApply = false;

  ingest(poll: PollSpec, frpMw: number | null = 12.5): PendingBatch {
    const availableAt = epochMsFromIso(poll.availableAt);
    for (const spec of poll.detections) {
      this.state.rows.set(uid(spec.n), {
        frpMw,
        dayNight: spec.dayNight ?? 'N',
        detection: {
          detectionUid: uid(spec.n),
          source: SOURCE,
          availableAt,
          acqTsIso: spec.acq,
          latCanonical: spec.lat ?? '41.86000',
          lonCanonical: spec.lon,
          scanKm: null,
          trackKm: null,
        },
      });
    }
    const batch: PendingBatch = { source: SOURCE, availableAt };
    this.state.ingestBatches.push(batch);
    return batch;
  }

  async liveRun(config: ClusteringConfig): Promise<ClusteringRun> {
    await yieldTurn();
    const run = this.state.run;
    if (run === null) {
      this.state.run = {
        id: 1,
        kind: 'live',
        configVersion: config.version,
        configDigest: config.digest,
        lifecycleTickedAtMs: null,
      };
      return this.state.run;
    }
    if (run.configVersion !== config.version) throw new Error('config version mismatch');
    return run;
  }

  async pendingBatches(
    _run: ClusteringRun,
    query: PendingBatchQuery,
  ): Promise<readonly PendingBatch[]> {
    await yieldTurn();
    const done = this.state.ingestBatches.filter((b) => this.state.ledger.has(batchKey(b)));
    const floor =
      done.length === 0 ? query.notBefore : Math.max(...done.map((b) => b.availableAt)) + 1;
    return this.state.ingestBatches
      .filter((b) => !this.state.ledger.has(batchKey(b)) && b.availableAt >= floor)
      .sort((a, b) => a.availableAt - b.availableAt || (a.source < b.source ? -1 : 1))
      .slice(0, query.limit);
  }

  async withBatch<T>(
    _run: ClusteringRun,
    batch: PendingBatch,
    work: (tx: BatchTransaction) => Promise<T>,
  ): Promise<T | null> {
    if (this.state.ledger.has(batchKey(batch))) return null;
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.batchTx(batch));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async withTick<T>(_run: ClusteringRun, work: (tx: TickTransaction) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.tickTx());
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  private member(detectionUid: string): StoredMember {
    const row = this.state.rows.get(detectionUid);
    if (row === undefined) throw new Error(`no row ${detectionUid}`);
    const d = row.detection;
    return {
      detectionUid,
      source: d.source,
      acqTsIso: d.acqTsIso,
      latCanonical: d.latCanonical,
      lonCanonical: d.lonCanonical,
      scanKm: d.scanKm,
      trackKm: d.trackKm,
      frpMw: row.frpMw,
    };
  }

  /** Every fake row carries the replay's constants (nominal), and its own day/night flag. */
  private scoringRow(detectionUid: string): ScoringDetection {
    const row = this.state.rows.get(detectionUid);
    if (row === undefined) throw new Error(`no row ${detectionUid}`);
    const d = row.detection;
    return {
      detectionUid: d.detectionUid,
      source: d.source,
      acqTsIso: d.acqTsIso,
      latCanonical: d.latCanonical,
      lonCanonical: d.lonCanonical,
      confidence: 'nominal',
      dayNight: row.dayNight,
      frpMw: row.frpMw,
      scanKm: d.scanKm,
      trackKm: d.trackKm,
      overOrAdjacentToWater: null,
    };
  }

  private assigned(): Set<string> {
    const all = new Set<string>();
    for (const event of this.state.events.values()) for (const m of event.members) all.add(m);
    return all;
  }

  private batchTx(batch: PendingBatch): BatchTransaction {
    const s = (): FakeState => this.state;
    return {
      loadDetections: async () => {
        await yieldTurn();
        const assigned = this.assigned();
        return [...s().rows.values()]
          .map((row) => row.detection)
          .filter(
            (d) =>
              d.availableAt === batch.availableAt &&
              d.source === batch.source &&
              !assigned.has(d.detectionUid),
          );
      },
      loadWorkingSet: async (activeSince) => {
        await yieldTurn();
        const clusters: StoredCluster[] = [];
        for (const row of s().clusters.values()) {
          const event = s().events.get(row.publicId);
          if (event === undefined) throw new Error(`cluster ${row.publicId} has no event`);
          const members = [...event.members].map((m) => this.member(m));
          const last = Math.max(...members.map((m) => epochMsFromIso(m.acqTsIso)));
          if (last >= activeSince) clusters.push({ ...row, members });
        }
        return {
          clusters,
          nextClusterId: s().nextId,
          takenPublicIds: [...s().events.keys()],
        };
      },
      loadAliases: async () => {
        await yieldTurn();
        const links = new Map<string, string>();
        for (const event of s().events.values()) {
          if (event.mergedInto !== null) links.set(event.publicId, event.mergedInto);
        }
        return links;
      },
      loadAlertStates: async (publicIds) => {
        await yieldTurn();
        const wanted = new Set(publicIds);
        return [...s().alertStates.values()].filter((row) => wanted.has(row.eventPublicId));
      },
      loadCandidates: async (queries: readonly ReignitionQuery[]) => {
        await yieldTurn();
        // Deliberately wider than the rule in space (no distance filter): the contract
        // says a wider set is correct, and the core re-tests distance.
        const notBefore = Math.min(...queries.map((q) => q.notBefore));
        const notAfter = Math.max(...queries.map((q) => q.notAfter));
        const out: ReignitionCandidateEvent[] = [];
        for (const event of s().events.values()) {
          const last = epochMsFromIso(event.lastDetectionAtIso);
          if (event.mergedInto !== null || event.clusterId === null) continue;
          if (last < notBefore || last > notAfter) continue;
          out.push({
            clusterId: event.clusterId,
            publicId: event.publicId,
            centroid: {
              lat: parseCanonicalDegrees(event.centroidLat, 'latitude'),
              lon: parseCanonicalDegrees(event.centroidLon, 'longitude'),
            },
            startedAt: epochMsFromIso(event.startedAtIso),
            lastDetectionAt: last,
            fuelBand: null,
          });
        }
        return out;
      },
      loadScoringDetections: async (keys) => {
        await yieldTurn();
        // Every fake row carries the replay's constant confidence (nominal) so that the live
        // bucket and `replayOf`'s bucket of the same member set can be compared.
        return keys.map((key) => {
          const row = s().rows.get(key.detectionUid);
          if (row === undefined || row.detection.acqTsIso !== key.acqTsIso) {
            throw new Error(`no scoring row ${key.detectionUid}`);
          }
          return this.scoringRow(key.detectionUid);
        });
      },
      applyBatch: async (write) => {
        await yieldTurn();
        this.apply(write);
      },
    };
  }

  private apply({ batch, result, writes, scores }: BatchWrite): void {
    const s = this.state;
    const ids = new Map<number, number>();
    for (const seeded of writes.seededEvents) {
      const initial = seeded.initial;
      const clusterId = seeded.absorbed ? null : s.nextId++;
      if (clusterId !== null) {
        ids.set(initial.clusterId, clusterId);
        s.clusters.set(clusterId, {
          id: clusterId,
          publicId: initial.publicId,
          seedDetectionUid: seeded.seedDetectionUid,
          mintedAt: seeded.mintedAt,
          configVersion: seeded.configVersion,
          sourceRegistryVersion: seeded.sourceRegistryVersion,
        });
      }
      s.events.set(initial.publicId, {
        publicId: initial.publicId,
        clusterId,
        status: 'active',
        displayTier: 'map',
        inactiveSinceMs: null,
        missEvidence: 0,
        geoWeightSpent: null,
        blindSinceMs: null,
        seenDetectionAtMs: null,
        mergedInto: null,
        relation: null,
        centroidLat: initial.centroidLatCanonical,
        centroidLon: initial.centroidLonCanonical,
        startedAtIso: initial.startedAtIso,
        lastDetectionAtIso: initial.lastDetectionAtIso,
        members: new Set(),
        score: null,
        scoreParamsVersion: null,
        invalidated: false,
        invalidatedReason: null,
        staticSource: null,
        seq: ++s.seq,
      });
    }
    // The engine's id of a pre-existing cluster is the store's id: it was read from here.
    const storeId = (engineId: number): number => ids.get(engineId) ?? engineId;

    for (const assignment of result.assignments) {
      const target = resolveAlias(writes.merge.aliases, assignment.publicId).canonical;
      const event = s.events.get(target);
      if (event === undefined) throw new Error(`assignment to unknown ${target}`);
      event.members.add(assignment.detectionUid);
    }
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error('injected failure halfway through applyBatch');
    }
    for (const tombstone of writes.merge.tombstones) {
      const event = s.events.get(tombstone.publicId);
      if (event === undefined) throw new Error(`tombstone of unknown ${tombstone.publicId}`);
      event.mergedInto = tombstone.mergedIntoPublicId;
      event.seq = ++s.seq;
    }
    for (const rewrite of writes.merge.aliasRewrites) {
      const event = s.events.get(rewrite.publicId);
      if (event !== undefined) event.mergedInto = rewrite.to;
    }
    for (const move of writes.merge.detectionReattributions) {
      const from = s.events.get(move.fromPublicId);
      const to = s.events.get(move.toPublicId);
      if (from === undefined || to === undefined) throw new Error('reattribution endpoint');
      for (const m of from.members) to.members.add(m);
      from.members.clear();
    }
    for (const merge of result.merges) {
      for (const absorbed of merge.absorbedClusterIds) s.clusters.delete(storeId(absorbed));
    }
    for (const key of writes.alertStates.deletes) s.alertStates.delete(alertKey(key));
    for (const row of writes.alertStates.upserts) s.alertStates.set(alertKey(row), row);
    for (const link of writes.reignitionLinks) {
      const event = s.events.get(link.publicId);
      if (event === undefined) throw new Error(`link from unknown ${link.publicId}`);
      event.relation = { publicId: link.relatedPublicId, kind: link.relationKind };
    }
    for (const update of writes.aggregates) {
      const event = s.events.get(update.publicId);
      if (event === undefined) throw new Error(`aggregate of unknown ${update.publicId}`);
      event.centroidLat = update.centroidLatCanonical;
      event.centroidLon = update.centroidLonCanonical;
      event.startedAtIso = update.startedAtIso;
      event.lastDetectionAtIso = update.lastDetectionAtIso;
      expect(event.members.size).toBe(update.detectionCount);
      // The port's contract: one score per aggregate, in the same order.
      const score = scores[writes.aggregates.indexOf(update)];
      expect(score?.publicId).toBe(update.publicId);
      event.score = score?.score ?? null;
      event.scoreParamsVersion = score?.paramsVersion ?? null;
      if (score !== undefined) applyVerdict(event, score);
      // One bump for members, aggregates and score together — as the SQL trigger does.
      event.seq = ++s.seq;
    }
    s.ledger.add(batchKey(batch));
  }

  private tickTx(): TickTransaction {
    const s = (): FakeState => this.state;
    const run = s().run;
    if (run === null) throw new Error('tick before liveRun');
    return {
      lastTickedAtMs: run.lifecycleTickedAtMs,
      loadTickEvents: async (activeSince) => {
        await yieldTurn();
        const out: StoredTickEvent[] = [];
        for (const event of s().events.values()) {
          if (event.mergedInto !== null || event.members.size === 0 || event.invalidated) {
            continue;
          }
          if (
            event.status === 'archived' &&
            epochMsFromIso(event.lastDetectionAtIso) < activeSince
          ) {
            continue;
          }
          out.push({
            publicId: event.publicId,
            status: event.status,
            displayTier: event.displayTier,
            inactiveSinceMs: event.inactiveSinceMs,
            missEvidence: event.missEvidence,
            geoWeightSpent: event.geoWeightSpent,
            blindSinceMs: event.blindSinceMs,
            seenDetectionAtMs: event.seenDetectionAtMs,
            members: [...event.members].map((m) => this.member(m)),
          });
        }
        return out;
      },
      events: {
        applyTransition: async (transition) => {
          await yieldTurn();
          s().transitions.push(transition);
          const event = s().events.get(transition.publicId);
          if (event === undefined || event.mergedInto !== null) return null;
          event.status = transition.status;
          event.displayTier = transition.displayTier;
          event.inactiveSinceMs = transition.inactiveSinceMs;
          event.seq = ++s().seq;
          return event.seq;
        },
      },
      saveCarries: async (carries: readonly StoredCarry[]) => {
        await yieldTurn();
        for (const carry of carries) {
          const event = s().events.get(carry.publicId);
          if (event === undefined) throw new Error(`carry for unknown ${carry.publicId}`);
          event.missEvidence = carry.missEvidence;
          event.geoWeightSpent = carry.geoWeightSpent;
          event.blindSinceMs = carry.blindSinceMs;
          event.seenDetectionAtMs = carry.seenDetectionAtMs;
        }
      },
      loadStaticSourceStale: async (query) => {
        await yieldTurn();
        const stale = [...s().events.values()]
          .filter(
            (e) =>
              e.mergedInto === null &&
              e.members.size > 0 &&
              !stickyInvalidation(e) &&
              (e.status !== 'archived' ||
                epochMsFromIso(e.lastDetectionAtIso) >= query.activeSince) &&
              (e.staticSource?.maskVersion !== query.maskVersion ||
                e.staticSource.policyVersion !== query.policyVersion),
          )
          .sort((a, b) => (a.publicId < b.publicId ? -1 : 1))
          .slice(0, query.limit);
        return stale.map((e) => ({
          publicId: e.publicId,
          rows: [...e.members]
            .map((m) => this.scoringRow(m))
            .sort((a, b) =>
              a.acqTsIso === b.acqTsIso
                ? a.detectionUid < b.detectionUid
                  ? -1
                  : 1
                : a.acqTsIso < b.acqTsIso
                  ? -1
                  : 1,
            ),
        }));
      },
      applyStaticSourceVerdicts: async (scores) => {
        await yieldTurn();
        for (const score of scores) {
          const event = s().events.get(score.publicId);
          if (event === undefined) throw new Error(`verdict for unknown ${score.publicId}`);
          const was = [event.score, event.invalidated];
          event.score = score.score;
          event.scoreParamsVersion = score.paramsVersion;
          applyVerdict(event, score);
          if (was[0] !== event.score || was[1] !== event.invalidated) event.seq = ++s().seq;
        }
      },
      markTicked: async (atMs) => {
        await yieldTurn();
        s().run = { ...run, lifecycleTickedAtMs: atMs };
      },
    };
  }

  /**
   * The registry in the replay's reporting vocabulary, labels aside. A live event's bucket
   * is its persisted score's bucket (`unscored` if nothing ever scored it, which would fail
   * parity loudly); a tombstone's is `null`, as the replay reports it.
   */
  report(): unknown[] {
    const links = new Map<string, string>();
    for (const e of this.state.events.values()) {
      if (e.mergedInto !== null) links.set(e.publicId, e.mergedInto);
    }
    return [...this.state.events.values()]
      .map((e) => ({
        publicId: e.publicId,
        status: e.mergedInto === null ? e.status : null,
        displayTier: e.mergedInto === null ? e.displayTier : null,
        detectionUids: [...e.members].sort(),
        bucket: e.mergedInto !== null ? null : e.score === null ? 'unscored' : scoreBucket(e.score),
        mergedInto: e.mergedInto === null ? null : resolveAlias(links, e.publicId).canonical,
        relation: e.relation,
      }))
      .sort((a, b) => (a.publicId < b.publicId ? -1 : 1));
  }
}

// ── drivers ───────────────────────────────────────────────────────────────────

function replayOf(clockStart: string, polls: readonly PollSpec[]): unknown[] {
  const manifest = parseFixtureManifest(
    {
      id: 'T-live-parity',
      title: 'live identity parity',
      asserts: 'the live cycle and the replay agree',
      required: 'suite',
      owner: 'WP2',
      engine: 'identity',
      clockStart,
      mode: 'live',
      allowRevive: false,
      configVersions: {
        clustering_params: 'clustering_params_v1',
        lifecycle_params: 'lifecycle_params_v1',
        pass_table: 'pass_table_v0',
        score_params: 'score_params_v0',
        sources: 'source_registry_v1',
      },
      inputs: polls.map((_, i) => `poll-${String(i)}.json`),
      expected: 'expected.json',
    },
    'T-live-parity/manifest.json',
  );
  const report = runReplay(
    {
      manifest,
      batches: polls.map((poll, i) =>
        parseReplayBatch(
          {
            availableAt: poll.availableAt,
            detections: poll.detections.map((d) => ({
              detectionUid: uid(d.n),
              source: SOURCE,
              acqTsIso: d.acq,
              latCanonical: d.lat ?? '41.86000',
              lonCanonical: d.lon,
              confidence: 'nominal',
              frpMw: 12.5,
              dayNight: 'N',
            })),
          },
          `poll-${String(i)}.json`,
        ),
      ),
      expected: null,
      observations: EMPTY_OBSERVATIONS,
    },
    identityEngine(),
  );
  return report.events
    .map((e: ReplayEvent) => ({
      publicId: e.publicId,
      status: e.status,
      displayTier: e.displayTier,
      detectionUids: [...e.detectionUids].sort(),
      bucket: e.bucket,
      mergedInto: e.mergedInto,
      relation: e.relation,
    }))
    .sort((a, b) => (a.publicId < b.publicId ? -1 : 1));
}

function deps(
  store: FakeStore,
  clock: VirtualClock,
  maxBatchesPerCycle = 16,
  staticSources?: StaticSourceEvaluator,
) {
  return {
    store,
    clock,
    config: CLUSTERING_PARAMS,
    predictor: staticPassPredictor(),
    maxBatchesPerCycle,
    ...(staticSources === undefined ? {} : { staticSources }),
  };
}

/** A mask of one flare node at (`lon`, 41.86) — the fake's default latitude. */
function flareAt(version: string, lon: number): StaticSourceEvaluator {
  const mask = parseStaticSourceMask({
    format: STATIC_SOURCE_FORMAT,
    version,
    licence: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    scale: 10_000,
    kinds: [...STATIC_SOURCE_KINDS],
    sources: [[STATIC_SOURCE_KINDS.indexOf('flare'), Math.round(lon * 10_000), 418_600]],
  });
  return staticSourceEvaluator(mask, STATIC_SOURCE_POLICY, CLUSTERING_PARAMS.values.metric);
}

/** One cycle per poll, the clock at the poll's instant — how `runReplay` advances. */
async function live(clockStart: string, polls: readonly PollSpec[]): Promise<FakeStore> {
  const store = new FakeStore();
  const clock = new VirtualClock(clockStart);
  // The replay's first tick window is [clockStart, first poll); the live pipeline's first
  // is empty. An initial cycle at clockStart gives both the same windows thereafter.
  await runIdentityCycle(deps(store, clock));
  for (const poll of polls) {
    store.ingest(poll);
    clock.set(poll.availableAt);
    await runIdentityCycle(deps(store, clock));
  }
  return store;
}

// ── scenarios (distances as in replay/identity-engine.test.ts) ─────────────────

const MERGE: readonly PollSpec[] = [
  {
    availableAt: '2026-08-05T03:10:00Z',
    detections: [
      { n: 1, acq: '2026-08-05T00:06:00Z', lon: '26.10000' },
      { n: 2, acq: '2026-08-05T00:06:00Z', lon: '26.13000' },
    ],
  },
  {
    availableAt: '2026-08-05T15:10:00Z',
    detections: [{ n: 3, acq: '2026-08-05T12:06:00Z', lon: '26.11500' }],
  },
];

/**
 * A seed and a bridge in one poll: the seed is absorbed before the batch commits. The
 * batch is ordered by coordinate (`batch-order.ts`), so the seed has to sort before the
 * bridge — west of it — and the older event has to sit east, out of the seed's reach.
 */
const SEED_ABSORBED: readonly PollSpec[] = [
  {
    availableAt: '2026-08-05T03:10:00Z',
    detections: [{ n: 1, acq: '2026-08-05T00:06:00Z', lon: '26.13000' }],
  },
  {
    availableAt: '2026-08-05T15:10:00Z',
    detections: [
      { n: 2, acq: '2026-08-05T12:06:00Z', lon: '26.10000' },
      { n: 3, acq: '2026-08-05T12:07:00Z', lon: '26.11500' },
    ],
  },
];

const REIGNITION: readonly PollSpec[] = [
  {
    availableAt: '2026-08-04T03:20:00Z',
    detections: [{ n: 1, acq: '2026-08-04T00:12:00Z', lon: '26.10000' }],
  },
  {
    availableAt: '2026-08-09T03:20:00Z',
    detections: [{ n: 2, acq: '2026-08-09T00:12:00Z', lon: '26.10500' }],
  },
];

/** Four nightly detections, then eleven quiet polls: the cluster leaves the working set. */
const AGEING: readonly PollSpec[] = [
  ...Array.from({ length: 4 }, (_, i) => ({
    availableAt: `2026-08-0${String(i + 1)}T03:00:00Z`,
    detections: [{ n: i + 1, acq: `2026-08-0${String(i + 1)}T00:30:00Z`, lon: '26.10000' }],
  })),
  ...Array.from({ length: 11 }, (_, i) => ({
    availableAt: `2026-08-${String(i + 5).padStart(2, '0')}T03:00:00Z`,
    detections: [],
  })),
];

describe('runIdentityCycle — parity with the golden replay', () => {
  it.each([
    ['merge across polls', '2026-08-05T03:00:00Z', MERGE],
    ['a seed absorbed within its own batch', '2026-08-05T03:00:00Z', SEED_ABSORBED],
    ['reignition after eviction', '2026-08-04T03:00:00Z', REIGNITION],
    ['a quiet fortnight after the last detection', '2026-08-01T02:00:00Z', AGEING],
  ])('%s: the live registry equals the replayed one', async (_name, start, polls) => {
    const store = await live(start, polls);
    expect(store.report()).toEqual(replayOf(start, polls));
  });

  it('the merge scenario really merged and the reignition scenario really linked', async () => {
    const merged = await live('2026-08-05T03:00:00Z', MERGE);
    expect(
      merged.report().filter((e) => (e as { mergedInto: unknown }).mergedInto !== null),
    ).toHaveLength(1);
    const reignited = await live('2026-08-04T03:00:00Z', REIGNITION);
    expect(
      reignited.report().filter((e) => (e as { relation: unknown }).relation !== null),
    ).toHaveLength(1);
  });

  it('an absorbed seed still gets a registry row, born a tombstone', async () => {
    const store = await live('2026-08-05T03:00:00Z', SEED_ABSORBED);
    const tombstones = [...store.state.events.values()].filter((e) => e.mergedInto !== null);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.clusterId).toBeNull();
    expect(tombstones[0]?.members.size).toBe(0);
  });
});

describe('runIdentityCycle — the persisted D6 score', () => {
  it('scores every live event over all its members, and leaves a tombstone unscored', async () => {
    const store = await live('2026-08-05T03:00:00Z', MERGE);
    const events = [...store.state.events.values()];
    const survivor = events.find((e) => e.mergedInto === null);
    const tombstone = events.find((e) => e.mergedInto !== null);
    if (survivor === undefined || tombstone === undefined) throw new Error('no merge');
    const members = [...survivor.members].map((m) => {
      const row = store.state.rows.get(m);
      if (row === undefined) throw new Error(`no row ${m}`);
      return {
        ...row.detection,
        confidence: 'nominal' as const,
        dayNight: 'N' as const,
        frpMw: row.frpMw,
        overOrAdjacentToWater: null,
      };
    });
    expect(members).toHaveLength(3);
    const expected = scoreEvent(members, LIVE_SCORE_CONTEXT);
    expect(survivor.score).toBe(expected.score);
    expect(survivor.score).toBeGreaterThan(0);
    expect(survivor.scoreParamsVersion).toBe('score_params_v0');
    // The tombstone's last score (from its one-detection life) stays; it is never rescored.
    expect(tombstone.scoreParamsVersion).toBe('score_params_v0');

    const absorbed = await live('2026-08-05T03:00:00Z', SEED_ABSORBED);
    const born = [...absorbed.state.events.values()].find((e) => e.clusterId === null);
    expect(born?.score).toBeNull();
    expect(born?.scoreParamsVersion).toBeNull();
  });

  it('never changes a score without a seq bump, and a lifecycle tick never rescores', async () => {
    const store = new FakeStore();
    const clock = new VirtualClock('2026-08-01T02:00:00Z');
    await runIdentityCycle(deps(store, clock));
    let before = new Map<string, { score: number | null; seq: number }>();
    const scores = new Set<number | null>();
    for (const poll of AGEING) {
      store.ingest(poll);
      clock.set(poll.availableAt);
      await runIdentityCycle(deps(store, clock));
      for (const event of store.state.events.values()) {
        const was = before.get(event.publicId);
        if (was !== undefined && was.score !== event.score) {
          expect(event.seq).toBeGreaterThan(was.seq);
        }
        if (poll.detections.length === 0 && was !== undefined) {
          expect(event.score).toBe(was.score);
        }
      }
      before = new Map(
        [...store.state.events.values()].map((e) => [e.publicId, { score: e.score, seq: e.seq }]),
      );
      for (const event of store.state.events.values()) scores.add(event.score);
    }
    // The quiet polls were ticked (with no weather declared nothing transitions)...
    expect(store.state.run?.lifecycleTickedAtMs).toBe(epochMsFromIso('2026-08-15T03:00:00Z'));
    // ...and the four attaches really moved the score (more detections, more persistence).
    expect(scores.size).toBeGreaterThan(1);
  });
});

describe('runIdentityCycle — the static-source verdict (TASKS F16)', () => {
  const ON_FLARE: PollSpec = {
    availableAt: '2026-08-05T03:10:00Z',
    detections: [
      { n: 1, acq: '2026-08-05T00:06:00Z', lon: '26.10000' },
      { n: 2, acq: '2026-08-05T00:06:00Z', lon: '26.10300' },
    ],
  };

  function only(store: FakeStore): FakeEvent {
    const events = [...store.state.events.values()].filter((e) => e.mergedInto === null);
    expect(events).toHaveLength(1);
    return events[0] as FakeEvent;
  }

  it('the tick re-judges a quiet event when the mask changes, both ways', async () => {
    const store = new FakeStore();
    const clock = new VirtualClock('2026-08-05T03:00:00Z');
    store.ingest(ON_FLARE);
    clock.set(ON_FLARE.availableAt);
    await runIdentityCycle(deps(store, clock));
    const event = only(store);
    const formula = event.score;
    expect(formula).toBeGreaterThan(0);
    expect(event.staticSource).toBeNull();

    // A deploy loads a mask with a flare under the event: no new detection, yet the sweep
    // finds it (its stamp says "never judged") and applies the override.
    clock.set('2026-08-05T04:00:00Z');
    const first = await runIdentityCycle(deps(store, clock, 16, flareAt('a', 26.1)));
    expect(first.tick).toMatchObject({ staticSourcesSwept: 1, staticSourcesLimitReached: false });
    expect(event).toMatchObject({
      score: 0,
      invalidated: true,
      invalidatedReason: 'static_source',
      staticSource: {
        verdict: 'static_source',
        maskVersion: 'a',
        policyVersion: STATIC_SOURCE_POLICY.version,
      },
    });
    const seq = event.seq;

    // Same versions: nothing is stale, nothing is written.
    clock.set('2026-08-05T05:00:00Z');
    const again = await runIdentityCycle(deps(store, clock, 16, flareAt('a', 26.1)));
    expect(again.tick.staticSourcesSwept).toBe(0);
    expect(event.seq).toBe(seq);

    // A corrected mask drops the flare: the next sweep releases the event, formula back.
    clock.set('2026-08-05T06:00:00Z');
    const fixed = await runIdentityCycle(deps(store, clock, 16, flareAt('b', 27)));
    expect(fixed.tick.staticSourcesSwept).toBe(1);
    expect(event).toMatchObject({
      score: formula,
      invalidated: false,
      invalidatedReason: null,
      staticSource: { verdict: 'clear', maskVersion: 'b' },
    });
    expect(event.seq).toBeGreaterThan(seq);
  });

  it('a detection off the mask releases the override (a fire next to a flare is shown)', async () => {
    const store = new FakeStore();
    const clock = new VirtualClock('2026-08-05T03:00:00Z');
    const evaluator = flareAt('a', 26.1);
    store.ingest(ON_FLARE);
    clock.set(ON_FLARE.availableAt);
    await runIdentityCycle(deps(store, clock, 16, evaluator));
    const event = only(store);
    expect(event.invalidatedReason).toBe('static_source');

    const spread: PollSpec = {
      availableAt: '2026-08-05T15:10:00Z',
      detections: [{ n: 3, acq: '2026-08-05T12:06:00Z', lon: '26.11500' }],
    };
    store.ingest(spread);
    clock.set(spread.availableAt);
    await runIdentityCycle(deps(store, clock, 16, evaluator));
    // Two members still sit on the flare, so the event keeps the caveat — but is shown.
    expect(only(store)).toMatchObject({
      invalidated: false,
      invalidatedReason: null,
      staticSource: { verdict: 'annotated' },
    });
    expect(only(store).score).toBeGreaterThan(0);
  });

  it('quarantines a day-only repeat and releases it on the first night detection', async () => {
    const store = new FakeStore();
    const clock = new VirtualClock('2026-08-01T00:00:00Z');
    const evaluator = flareAt('a', 30); // nothing near: the quarantine needs no mask
    const polls: PollSpec[] = [
      {
        availableAt: '2026-08-01T13:00:00Z',
        detections: [
          { n: 1, acq: '2026-08-01T10:40:00Z', lon: '26.10000', dayNight: 'D' },
          { n: 2, acq: '2026-08-01T10:41:00Z', lon: '26.10100', dayNight: 'D' },
        ],
      },
      {
        availableAt: '2026-08-02T13:00:00Z',
        detections: [{ n: 3, acq: '2026-08-02T10:40:00Z', lon: '26.10000', dayNight: 'D' }],
      },
    ];
    for (const poll of polls) {
      store.ingest(poll);
      clock.set(poll.availableAt);
      await runIdentityCycle(deps(store, clock, 16, evaluator));
    }
    const event = only(store);
    expect(event.members.size).toBe(3);
    expect(event).toMatchObject({
      invalidated: true,
      invalidatedReason: 'suspected_static_source',
      staticSource: { verdict: 'suspected_static_source' },
    });
    // The quarantine keeps the formula's score (it is a suspicion, not the override).
    expect(event.score).toBeGreaterThan(0);

    const night: PollSpec = {
      availableAt: '2026-08-03T03:00:00Z',
      detections: [{ n: 4, acq: '2026-08-03T00:30:00Z', lon: '26.10000', dayNight: 'N' }],
    };
    store.ingest(night);
    clock.set(night.availableAt);
    await runIdentityCycle(deps(store, clock, 16, evaluator));
    expect(only(store)).toMatchObject({
      invalidated: false,
      invalidatedReason: null,
      staticSource: { verdict: 'clear' },
    });
  });

  it('never releases curation: a sticky invalidation is neither swept nor rewritten', async () => {
    const store = new FakeStore();
    const clock = new VirtualClock('2026-08-05T03:00:00Z');
    store.ingest(ON_FLARE);
    clock.set(ON_FLARE.availableAt);
    await runIdentityCycle(deps(store, clock));
    const event = only(store);
    event.invalidated = true;
    event.invalidatedReason = 'curated_not_fire';
    clock.set('2026-08-05T04:00:00Z');
    const report = await runIdentityCycle(deps(store, clock, 16, flareAt('b', 27)));
    expect(report.tick.staticSourcesSwept).toBe(0);
    expect(event).toMatchObject({ invalidated: true, invalidatedReason: 'curated_not_fire' });
  });

  it('with no evaluator wired nothing is swept and no stamp is written', async () => {
    const store = await live('2026-08-05T03:00:00Z', [ON_FLARE]);
    expect(only(store).staticSource).toBeNull();
    expect(only(store).invalidated).toBe(false);
  });
});

describe('runIdentityCycle — bookkeeping', () => {
  it('skips a batch another writer already put in the ledger', async () => {
    const store = new FakeStore();
    const clock = new VirtualClock('2026-08-05T04:00:00Z');
    const batch = store.ingest(MERGE[0] as PollSpec);
    await store.liveRun(CLUSTERING_PARAMS);
    // Simulates the race the lock resolves: pending when listed, recorded when locked.
    const original = store.withBatch.bind(store);
    store.withBatch = async (run, b, work) => {
      store.state.ledger.add(batchKey(batch));
      return original(run, b, work);
    };
    const report = await runIdentityCycle(deps(store, clock));
    expect(report.batches).toEqual({ pending: 1, applied: 0, skipped: 1, limitReached: false });
    expect(store.state.events.size).toBe(0);
  });

  it('a failing batch rolls back whole and is retried next cycle', async () => {
    const store = new FakeStore();
    const clock = new VirtualClock('2026-08-05T04:00:00Z');
    store.ingest(MERGE[0] as PollSpec);
    store.failNextApply = true;
    await expect(runIdentityCycle(deps(store, clock))).rejects.toThrow(/injected failure/);
    expect(store.state.events.size).toBe(0);
    expect(store.state.ledger.size).toBe(0);

    const report = await runIdentityCycle(deps(store, clock));
    expect(report.batches.applied).toBe(1);
    expect(report.stats.seeded).toBe(2);
    expect(store.state.events.size).toBe(2);
  });

  it('takes at most maxBatchesPerCycle batches and says so', async () => {
    const store = new FakeStore();
    const clock = new VirtualClock('2026-08-05T16:00:00Z');
    for (const poll of MERGE) store.ingest(poll);
    const first = await runIdentityCycle(deps(store, clock, 1));
    expect(first.batches).toEqual({ pending: 1, applied: 1, skipped: 0, limitReached: true });
    const second = await runIdentityCycle(deps(store, clock, 1));
    expect(second.batches.applied).toBe(1);
    expect(second.stats.merged).toBe(1);
    const third = await runIdentityCycle(deps(store, clock, 1));
    expect(third.batches).toEqual({ pending: 0, applied: 0, skipped: 0, limitReached: false });
  });

  it('never offers a batch older than one active window to a fresh run', async () => {
    const store = new FakeStore();
    store.ingest(MERGE[0] as PollSpec);
    const clock = new VirtualClock('2026-08-09T03:10:01Z');
    const report = await runIdentityCycle(deps(store, clock));
    expect(report.batches.pending).toBe(0);
  });

  it('rejects a non-positive batch limit', async () => {
    const store = new FakeStore();
    const clock = new VirtualClock('2026-08-05T04:00:00Z');
    await expect(runIdentityCycle(deps(store, clock, 0))).rejects.toThrow(RangeError);
  });

  it('writes a transition only when the decision differs from the row', async () => {
    // With no weather declared nothing accrues, so the decision stays `active`/`map` — and
    // a row that says otherwise is the one difference the tick has to write back.
    const store = await live('2026-08-05T03:00:00Z', MERGE.slice(0, 1));
    expect(store.state.transitions).toEqual([]);
    const event = [...store.state.events.values()][0];
    if (event === undefined) throw new Error('no event');
    event.displayTier = 'feed';
    const seqBefore = event.seq;

    const clock = new VirtualClock('2026-08-05T06:00:00Z');
    const first = await runIdentityCycle(deps(store, clock));
    expect(first.tick.transitions).toBe(1);
    expect(store.state.transitions).toHaveLength(1);
    expect(store.state.transitions[0]).toMatchObject({
      publicId: event.publicId,
      status: 'active',
      displayTier: 'map',
      atMs: epochMsFromIso('2026-08-05T06:00:00Z'),
    });
    expect(event.seq).toBeGreaterThan(seqBefore);

    clock.set('2026-08-05T09:00:00Z');
    const second = await runIdentityCycle(deps(store, clock));
    expect(second.tick.transitions).toBe(0);
    expect(store.state.transitions).toHaveLength(1);
  });

  it('counts a transition the store refused as missing, not as written', async () => {
    const store = await live('2026-08-05T03:00:00Z', MERGE.slice(0, 1));
    const event = [...store.state.events.values()][0];
    if (event === undefined) throw new Error('no event');
    event.displayTier = 'feed';
    const original = store.withTick.bind(store);
    store.withTick = async (run, work) =>
      original(run, (tx) =>
        work({ ...tx, events: { applyTransition: () => Promise.resolve(null) } }),
      );
    const report = await runIdentityCycle(deps(store, new VirtualClock('2026-08-05T06:00:00Z')));
    expect(report.tick).toMatchObject({ transitions: 0, missing: 1 });
  });

  it('carries the last seen detection into the stored carry', async () => {
    const store = await live('2026-08-01T02:00:00Z', AGEING);
    const event = [...store.state.events.values()][0];
    expect(event?.seenDetectionAtMs).toBe(epochMsFromIso('2026-08-04T00:30:00Z'));
    expect(store.state.run?.lifecycleTickedAtMs).toBe(epochMsFromIso('2026-08-15T03:00:00Z'));
  });

  it('never moves the tick backwards when the clock does', async () => {
    const store = await live('2026-08-05T03:00:00Z', MERGE.slice(0, 1));
    const ticked = store.state.run?.lifecycleTickedAtMs;
    const report = await runIdentityCycle(deps(store, new VirtualClock('2026-08-05T01:00:00Z')));
    expect(epochMsFromIso(report.tick.atIso)).toBe(ticked);
    expect(report.tick.sinceIso).toBe(report.tick.atIso);
  });

  it('does not tick an event in a curated state', async () => {
    const store = await live('2026-08-05T03:00:00Z', MERGE.slice(0, 1));
    const event = [...store.state.events.values()][0];
    if (event === undefined) throw new Error('no event');
    event.status = 'officially_contained';
    event.displayTier = 'feed';
    event.inactiveSinceMs = epochMsFromIso('2026-08-05T03:10:00Z');
    const clock = new VirtualClock('2026-08-06T03:00:00Z');
    const report = await runIdentityCycle(deps(store, clock));
    expect(report.tick.curatedSkipped).toBe(1);
    expect(event.status).toBe('officially_contained');
  });
});

describe('tickWindowStart', () => {
  const at = epochMsFromIso('2026-08-05T00:00:00Z');

  it('is empty on the first tick', () => {
    expect(tickWindowStart(at, null)).toBe(at);
  });

  it('starts at the previous tick', () => {
    expect(tickWindowStart(at, at - HOUR)).toBe(at - HOUR);
  });

  it('is clamped to what the pass predictor accepts', () => {
    expect(tickWindowStart(at, at - 500 * DAY)).toBe(at - MAX_TICK_WINDOW_MS);
    // And the clamped window really is accepted.
    expect(() =>
      staticPassPredictor().expectedPasses?.(
        { lat: 42, lon: 25 },
        at - MAX_TICK_WINDOW_MS - DAY / 2,
        at,
      ),
    ).not.toThrow();
  });

  it('never starts after it ends', () => {
    expect(tickWindowStart(at, at + HOUR)).toBe(at);
  });
});
