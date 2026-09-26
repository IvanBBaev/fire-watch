/**
 * The live identity pipeline's persistence over Postgres (ADR-002 D1 layers 2–3, D4;
 * TASKS D1/D4 wiring). Implements {@link ClusteringStore}; the core decides, this module
 * only reads and writes what the core asked for, in the transaction the port prescribes.
 *
 * ## Transactions and the run lock
 *
 * `withBatch` and `withTick` each check out one client, `BEGIN`, and take
 * `SELECT … FROM clustering_runs WHERE id = $1 FOR UPDATE` before reading anything. The
 * row lock is what serialises two writers on the same run — a restarted worker whose
 * predecessor has not quite died, an operator's one-shot CLI — and it is taken *before*
 * the ledger check, so the second writer to arrive sees the first one's ledger row and
 * skips the batch instead of re-minting the same public ids into a unique-index failure
 * halfway through an all-or-nothing plan (I3). The runtime role holds UPDATE on
 * `clustering_runs`, which is the privilege `FOR UPDATE` needs.
 *
 * `liveRun` serialises on a transaction-scoped advisory lock instead, because the row it
 * would lock may not exist yet: two workers starting together must not create two live
 * runs, and 001 has no unique index that would stop them.
 *
 * ## Engine cluster ids and database ids
 *
 * `clusters.id` is `GENERATED ALWAYS AS IDENTITY`, so the database, not the engine, picks
 * the id of a new working-set row. That is sound because the tie-breaks depend only on
 * the *order* of internal ids (the port's contract), and order is preserved: every new
 * row gets an id above every existing one, and the seeds of one batch are inserted one
 * statement each in ascending engine id, so identity values are drawn in that order.
 * `nextClusterId` is `max(clusters.id) + 1` over every run — strictly above anything the
 * working set can hold, which is all `stateFromStored` checks. Everything else a batch
 * writes is keyed by `public_id`, which the engine and the registry agree on by
 * construction, so no engine-id → database-id map ever has to be carried through a plan.
 *
 * ## Where this departs from the plan's wording, and why
 *
 *   - **Detection re-attribution copies, it does not move.** `merge-plan.ts` describes
 *     an UPDATE of `event_detections.fire_event_id`; the runtime role holds only SELECT
 *     and INSERT on that table (it is the append-only provenance of every assignment), so
 *     the loser's rows are copied onto the survivor with `ON CONFLICT DO NOTHING` and the
 *     originals stay under the tombstone. Every member read here goes through a *live*
 *     event's `clusters` row, never through `event_detections` alone, so the copies left
 *     behind are never counted twice.
 *   - **An absorbed seed bumps `seq` twice**: once on insert (the column default) and
 *     once when the tombstone step sets `merged_into` (004's trigger). A single insert
 *     already carrying `merged_into` would need the survivor's internal id before the
 *     survivor may have been inserted; two bumps cost nothing a client can observe.
 *   - **Reignition candidates carry the stored centroid** (`fire_events.centroid`, the
 *     5 dp grid), where the replay computes a float centroid from the members. The
 *     rule's distance comparison is quantised to 1 mm and the grid is ~1 m, so a tie the
 *     replay breaks one way could in principle break the other here. Stated rather than
 *     hidden; recomputing from members would cost a member read per candidate.
 *
 * Every statement is exported as {@link PG_CLUSTERING_SQL} so the unit tests can pin the
 * shape; the integration test is what proves the SQL against the real schema.
 */

import { assertSourceId, isLifecycleState } from '@fire-watch/contracts';

import type { ClusteringConfig, ClusteringDetection } from '../../core/clustering/types.js';
import { canonicalJson } from '../../core/determinism/canonical-json.js';
import { canonicalPublicId } from '../../core/identity/identity-batch.js';
import { DISPLAY_TIERS, type DisplayTier } from '../../core/lifecycle/types.js';
import { isoFromEpochMs, type EpochMs } from '../../core/ports/clock.js';
import type {
  BatchTransaction,
  BatchWrite,
  ClusteringRun,
  ClusteringStore,
  EventScore,
  PendingBatch,
  PendingBatchQuery,
  ScoringDetectionKey,
  StoredCarry,
  StoredCluster,
  StoredMember,
  StoredTickEvent,
  StoredWorkingSet,
  TickTransaction,
} from '../../core/ports/clustering-store.js';
import type {
  ReignitionCandidateEvent,
  ReignitionQuery,
} from '../../core/ports/reignition-reader.js';
import type { AliasLinks } from '../../core/registry/alias-registry.js';
import type { HullVertex, SurvivorUpdate } from '../../core/registry/merge-plan.js';
import type { ScoringDetection } from '../../core/scoring/features.js';
import { createPgAlertStateStore, type PgAlertStateQueryable } from './pg-alert-state-store.js';
import { createPgEventStatusStore } from './pg-event-status-store.js';
import { epochMs, field, number, seqFrom, string } from './pg-rows.js';

/**
 * A checked-out client. The alert-state slice is the widest one used on it (generic rows
 * plus `rowCount`), and it is also what the event-status store needs, so one interface
 * covers every statement issued inside a transaction.
 */
export interface PgClusteringClient extends PgAlertStateQueryable {
  release(): void;
}

export interface PgClusteringPool {
  connect(): Promise<PgClusteringClient>;
}

/**
 * Serialises live-run creation. An arbitrary constant: advisory keys are a namespace
 * shared by the whole database, and this is the only one the application takes.
 */
export const LIVE_RUN_LOCK_KEY = 7_331_002;

/**
 * Margin on the reignition radius, in metres. The core re-tests every candidate against
 * the rule on its own planar metric; PostGIS measures on the spheroid. The two disagree by
 * far less than this at Bulgarian latitudes and radii of a few km, and a reader that
 * returns a wider set is correct but slower (the port's contract), so the margin only
 * has to be generous, not exact.
 */
const CANDIDATE_MARGIN_M = 250;

const LOCK_LIVE_RUNS = 'SELECT pg_advisory_xact_lock($1)';

const SELECT_LIVE_RUNS = `
SELECT id::text AS id, kind, config_version, config_digest, lifecycle_ticked_at
  FROM clustering_runs
 WHERE kind = 'live'
 ORDER BY id
`.trim();

const INSERT_LIVE_RUN = `
INSERT INTO clustering_runs (kind, config_version, config_digest, params)
VALUES ('live', $1, $2, $3::jsonb)
RETURNING id::text AS id, kind, config_version, config_digest, lifecycle_ticked_at
`.trim();

/**
 * The cursor is the newest ledger entry as a `(available_at, source)` tuple, compared
 * as a tuple: two sources polled in the same instant are two batches, and a plain
 * `available_at >` would skip the second one forever. `COLLATE "C"` makes the source
 * order bytewise, which is the order the engine and the replay sort sources in.
 */
const SELECT_PENDING_BATCHES = `
WITH cursor AS (
  SELECT available_at, source
    FROM clustering_batches
   WHERE clustering_run_id = $1
   ORDER BY available_at DESC, source COLLATE "C" DESC
   LIMIT 1
)
SELECT b.source, b.available_at
  FROM ingest_batches b
  LEFT JOIN cursor c ON true
 WHERE (c.available_at IS NULL AND b.available_at >= $2)
    OR (c.available_at IS NOT NULL
        AND (b.available_at > c.available_at
             OR (b.available_at = c.available_at
                 AND b.source COLLATE "C" > c.source COLLATE "C")))
 ORDER BY b.available_at, b.source COLLATE "C"
 LIMIT $3
`.trim();

const LOCK_RUN = `
SELECT lifecycle_ticked_at FROM clustering_runs WHERE id = $1 FOR UPDATE
`.trim();

const SELECT_LEDGER_ENTRY = `
SELECT 1 FROM clustering_batches
 WHERE clustering_run_id = $1 AND available_at = $2 AND source = $3
`.trim();

/**
 * Exactly the rows the poll inserted: a detection's `available_at` is the first poll
 * that delivered it, so re-delivered rows belong to their original batch and are not
 * here. Quarantined rows are not evidence of a fire (E1) and are never clustered.
 */
const SELECT_BATCH_DETECTIONS = `
SELECT detection_uid, source, available_at, acq_ts, lat::text AS lat, lon::text AS lon,
       scan_km, track_km
  FROM detections
 WHERE available_at = $1 AND source = $2 AND NOT quarantined
 ORDER BY detection_uid COLLATE "C"
`.trim();

/**
 * The scorer's rows, by `(acq_ts, detection_uid)` so the lookup prunes on the partition key.
 * Only detections the core named as members of a rescored event are asked for, and a member
 * is never quarantined, so there is no quarantine filter to get wrong.
 */
const SELECT_SCORING_DETECTIONS = `
SELECT d.detection_uid, d.source, d.acq_ts, d.lat::text AS lat, d.lon::text AS lon,
       d.confidence, d.day_night, d.frp_mw, d.scan_km, d.track_km
  FROM unnest($1::text[], $2::timestamptz[]) AS k(detection_uid, acq_ts)
  JOIN detections d ON d.acq_ts = k.acq_ts AND d.detection_uid = k.detection_uid
 ORDER BY d.acq_ts, d.detection_uid COLLATE "C"
`.trim();

/** The member columns every member read projects, in {@link decodeMember}'s names. */
const MEMBER_COLUMNS = `
d.detection_uid, d.source, d.acq_ts, d.lat::text AS lat, d.lon::text AS lon,
d.scan_km, d.track_km, d.frp_mw
`.trim();

/**
 * The working set: live-run clusters whose event is still live, with their members.
 * Members are reached through the cluster's *current* event, which is what makes the
 * copies a merge leaves under a tombstone invisible here.
 */
const SELECT_WORKING_SET = `
SELECT c.id::text AS cluster_id, e.public_id, c.seed_detection_uid, c.minted_at,
       e.config_version, e.source_registry_version,
       ${MEMBER_COLUMNS}
  FROM clusters c
  JOIN fire_events e ON e.id = c.fire_event_id AND e.merged_into IS NULL
  JOIN event_detections ed
    ON ed.clustering_run_id = c.clustering_run_id AND ed.fire_event_id = c.fire_event_id
  JOIN detections d ON d.acq_ts = ed.acq_ts AND d.detection_uid = ed.detection_uid
 WHERE c.clustering_run_id = $1 AND c.last_detection_at >= $2
 ORDER BY c.id, d.acq_ts, d.detection_uid COLLATE "C"
`.trim();

const SELECT_NEXT_CLUSTER_ID = `
SELECT (COALESCE(max(id), 0) + 1)::text AS next_id FROM clusters
`.trim();

const SELECT_PUBLIC_IDS = `
SELECT public_id FROM fire_events ORDER BY public_id COLLATE "C"
`.trim();

const SELECT_ALIASES = `
SELECT t.public_id AS tombstone, s.public_id AS survivor
  FROM fire_events t
  JOIN fire_events s ON s.id = t.merged_into
 ORDER BY t.public_id COLLATE "C"
`.trim();

/**
 * Live, non-invalidated events of the run near any of the queried points and last
 * detected inside that query's window. One statement for the whole batch: the queries
 * arrive as parallel arrays and are joined as a set.
 */
const SELECT_REIGNITION_CANDIDATES = `
SELECT DISTINCT ON (c.id) c.id::text AS cluster_id, e.public_id,
       ST_Y(e.centroid) AS lat, ST_X(e.centroid) AS lon,
       e.started_at, e.last_detection_at
  FROM unnest($2::double precision[], $3::double precision[], $4::double precision[],
              $5::timestamptz[], $6::timestamptz[])
         AS q(lat, lon, radius_m, not_before, not_after)
  JOIN fire_events e
    ON e.merged_into IS NULL
   AND NOT e.invalidated
   AND e.last_detection_at BETWEEN q.not_before AND q.not_after
   AND ST_DWithin(e.centroid::geography,
                  ST_SetSRID(ST_MakePoint(q.lon, q.lat), 4326)::geography,
                  q.radius_m)
  JOIN clusters c ON c.fire_event_id = e.id AND c.clustering_run_id = $1
 ORDER BY c.id
`.trim();

/**
 * A seed's registry row. `status_changed_at` is the minting instant: the event entered
 * `active` when it was minted, and that is the batch instant, not the wall clock.
 */
const INSERT_SEEDED_EVENT = `
INSERT INTO fire_events (
  public_id, status, status_changed_at, display_tier, started_at, last_detection_at,
  centroid, hull, hull_diameter_km, needs_review, detection_count, source_mix,
  config_version, source_registry_version
)
VALUES (
  $1, 'active', $2, 'map', $3, $4,
  ST_SetSRID(ST_MakePoint($6::double precision, $5::double precision), 4326),
  ST_GeomFromText($7, 4326), $8, $9, $10, $11::jsonb,
  $12, $13
)
RETURNING id::text AS id
`.trim();

const INSERT_CLUSTER = `
INSERT INTO clusters (
  clustering_run_id, fire_event_id, centroid, hull, first_detection_at, last_detection_at,
  detection_count, seed_detection_uid, minted_at
)
VALUES (
  $1, $2, ST_SetSRID(ST_MakePoint($4::double precision, $3::double precision), 4326),
  ST_GeomFromText($5, 4326), $6, $7, $8, $9, $10
)
`.trim();

/**
 * `LEFT JOIN` so an assignment to an unknown public id fails the statement on the NOT
 * NULL `fire_event_id` instead of being dropped by an inner join — the same trick, for
 * the same reason, as the alert-state upsert. No `ON CONFLICT`: the engine never assigns a
 * detection it already holds (`alreadyAssigned`), so a conflict here is a bug to surface.
 */
const INSERT_ASSIGNMENTS = `
INSERT INTO event_detections (clustering_run_id, fire_event_id, detection_uid, acq_ts)
SELECT $1, e.id, a.detection_uid, a.acq_ts
  FROM unnest($2::text[], $3::text[], $4::timestamptz[]) AS a(public_id, detection_uid, acq_ts)
  LEFT JOIN fire_events e ON e.public_id = a.public_id
`.trim();

const UPDATE_TOMBSTONES = `
UPDATE fire_events t
   SET merged_into = s.id, updated_at = now()
  FROM unnest($1::text[], $2::text[]) AS m(public_id, merged_into)
  JOIN fire_events s ON s.public_id = m.merged_into
 WHERE t.public_id = m.public_id
`.trim();

const COPY_REATTRIBUTED_DETECTIONS = `
INSERT INTO event_detections (clustering_run_id, fire_event_id, detection_uid, acq_ts)
SELECT $1, t.id, ed.detection_uid, ed.acq_ts
  FROM unnest($2::text[], $3::text[]) AS m(from_id, to_id)
  JOIN fire_events f ON f.public_id = m.from_id
  JOIN fire_events t ON t.public_id = m.to_id
  JOIN event_detections ed ON ed.clustering_run_id = $1 AND ed.fire_event_id = f.id
ON CONFLICT DO NOTHING
`.trim();

/** Working-set rows of the clusters a merge absorbed. The tombstones stay in the registry. */
const DELETE_ABSORBED_CLUSTERS = `
DELETE FROM clusters c
 USING fire_events e
 WHERE c.clustering_run_id = $1
   AND c.fire_event_id = e.id
   AND e.public_id = ANY($2::text[])
`.trim();

const UPDATE_REIGNITION_LINKS = `
UPDATE fire_events e
   SET related_event_id = r.id, relation_kind = l.relation_kind, updated_at = now()
  FROM unnest($1::text[], $2::text[], $3::text[]) AS l(public_id, related_public_id, relation_kind)
  JOIN fire_events r ON r.public_id = l.related_public_id
 WHERE e.public_id = l.public_id AND e.merged_into IS NULL
`.trim();

/**
 * The arrays both aggregate statements unnest, in {@link aggregateArrays}' order. The score
 * columns ride along in the same unnest (the cluster statement ignores them) so that one
 * set of arrays, aligned by construction, is what both statements read.
 */
const AGGREGATE_UNNEST = `
unnest($2::text[], $3::timestamptz[], $4::timestamptz[], $5::integer[], $6::text[],
       $7::double precision[], $8::double precision[], $9::text[], $10::real[], $11::boolean[],
       $12::real[], $13::text[], $14::boolean[])
  AS a(public_id, started_at, last_detection_at, detection_count, source_mix,
       lat, lon, hull, hull_diameter_km, needs_review,
       score, score_params_version, score_invalidated)
`.trim();

/**
 * The projection of every changed live event. FRP is not part of the core's aggregate —
 * it is a scoring input, deliberately absent from identity — so max and sum are taken
 * here from the members the event holds after this batch. 004's trigger draws the `seq`
 * bump iff a projected column actually changed.
 *
 * The D6 score is written here too, never on its own. A score changes only when the member
 * set does (the context inputs are constants — `LIVE_SCORE_CONTEXT`), and a member change
 * already moves `detection_count`/`last_detection_at`, so the one bump the trigger draws
 * for this row covers the score: no extra bump, and never a score change without one — the
 * alert evaluation's `seq` cursor (009) sees every rescore. `score` is `real`; a score is
 * quantised to 1e-6 in [0,1], at most six significant digits, which float4 holds exactly
 * enough to print back (shortest round-trip output, PG ≥ 12) as the same double, so an
 * unchanged score rewritten is an unchanged column and draws no bump.
 *
 * `invalidated` is only ever set here, by the §3.6 static-source override, and never
 * cleared: un-invalidating is a curation decision, not a rescore's.
 */
const UPDATE_EVENT_AGGREGATES = `
UPDATE fire_events e
   SET started_at = a.started_at,
       last_detection_at = a.last_detection_at,
       detection_count = a.detection_count,
       source_mix = a.source_mix::jsonb,
       centroid = ST_SetSRID(ST_MakePoint(a.lon, a.lat), 4326),
       hull = ST_GeomFromText(a.hull, 4326),
       hull_diameter_km = a.hull_diameter_km,
       needs_review = a.needs_review,
       max_frp_mw = frp.max_frp_mw,
       sum_frp_mw = frp.sum_frp_mw,
       score = a.score,
       score_params_version = a.score_params_version,
       invalidated = e.invalidated OR a.score_invalidated,
       invalidated_reason = CASE
         WHEN e.invalidated THEN e.invalidated_reason
         WHEN a.score_invalidated THEN 'static_source_mask'
         ELSE e.invalidated_reason
       END,
       updated_at = now()
  FROM ${AGGREGATE_UNNEST}
  CROSS JOIN LATERAL (
    SELECT max(d.frp_mw) AS max_frp_mw, sum(d.frp_mw) AS sum_frp_mw
      FROM fire_events own
      JOIN event_detections ed
        ON ed.clustering_run_id = $1 AND ed.fire_event_id = own.id
      JOIN detections d ON d.acq_ts = ed.acq_ts AND d.detection_uid = ed.detection_uid
     WHERE own.public_id = a.public_id
  ) AS frp
 WHERE e.public_id = a.public_id AND e.merged_into IS NULL
`.trim();

const UPDATE_CLUSTER_AGGREGATES = `
UPDATE clusters c
   SET centroid = ST_SetSRID(ST_MakePoint(a.lon, a.lat), 4326),
       hull = ST_GeomFromText(a.hull, 4326),
       first_detection_at = a.started_at,
       last_detection_at = a.last_detection_at,
       detection_count = a.detection_count,
       updated_at = now()
  FROM ${AGGREGATE_UNNEST}
  JOIN fire_events e ON e.public_id = a.public_id
 WHERE c.clustering_run_id = $1 AND c.fire_event_id = e.id
`.trim();

const INSERT_LEDGER_ENTRY = `
INSERT INTO clustering_batches (
  clustering_run_id, source, available_at, detections, seeded, attached, merged,
  unattached, already_assigned
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`.trim();

/**
 * Every event of the run the tick still has work on (see `TickTransaction`), with its
 * members. Curated events are returned and left to the core to set aside, so the count
 * of them can be reported rather than silently shrinking the set.
 */
const SELECT_TICK_EVENTS = `
SELECT e.public_id, e.status, e.display_tier, e.inactive_since, e.miss_evidence,
       e.geo_weight_day, e.geo_weight_spent, e.lifecycle_blind_since,
       e.lifecycle_seen_detection_at,
       ${MEMBER_COLUMNS}
  FROM clusters c
  JOIN fire_events e ON e.id = c.fire_event_id
  JOIN event_detections ed
    ON ed.clustering_run_id = c.clustering_run_id AND ed.fire_event_id = c.fire_event_id
  JOIN detections d ON d.acq_ts = ed.acq_ts AND d.detection_uid = ed.detection_uid
 WHERE c.clustering_run_id = $1
   AND e.merged_into IS NULL
   AND NOT e.invalidated
   AND (e.status <> 'archived' OR e.last_detection_at >= $2)
 ORDER BY e.public_id COLLATE "C", d.acq_ts, d.detection_uid COLLATE "C"
`.trim();

/**
 * The carry. None of these columns is in 004's trigger list, so writing them every tick
 * moves no `seq` and invalidates no client cache; `updated_at` is left alone for the same
 * reason — it is the timestamp of the last change anyone could see.
 */
const UPDATE_CARRIES = `
UPDATE fire_events e
   SET miss_evidence = c.miss_evidence,
       geo_weight_day = c.geo_weight_day,
       geo_weight_spent = c.geo_weight_spent,
       lifecycle_blind_since = c.blind_since,
       lifecycle_seen_detection_at = c.seen_detection_at
  FROM unnest($1::text[], $2::double precision[], $3::timestamptz[], $4::double precision[],
              $5::timestamptz[], $6::timestamptz[])
         AS c(public_id, miss_evidence, geo_weight_day, geo_weight_spent, seen_detection_at,
              blind_since)
 WHERE e.public_id = c.public_id AND e.merged_into IS NULL
`.trim();

const UPDATE_TICKED_AT = `
UPDATE clustering_runs SET lifecycle_ticked_at = $2 WHERE id = $1
`.trim();

export const PG_CLUSTERING_SQL = Object.freeze({
  lockLiveRuns: LOCK_LIVE_RUNS,
  selectLiveRuns: SELECT_LIVE_RUNS,
  insertLiveRun: INSERT_LIVE_RUN,
  selectPendingBatches: SELECT_PENDING_BATCHES,
  lockRun: LOCK_RUN,
  selectLedgerEntry: SELECT_LEDGER_ENTRY,
  selectBatchDetections: SELECT_BATCH_DETECTIONS,
  selectScoringDetections: SELECT_SCORING_DETECTIONS,
  selectWorkingSet: SELECT_WORKING_SET,
  selectNextClusterId: SELECT_NEXT_CLUSTER_ID,
  selectPublicIds: SELECT_PUBLIC_IDS,
  selectAliases: SELECT_ALIASES,
  selectReignitionCandidates: SELECT_REIGNITION_CANDIDATES,
  insertSeededEvent: INSERT_SEEDED_EVENT,
  insertCluster: INSERT_CLUSTER,
  insertAssignments: INSERT_ASSIGNMENTS,
  updateTombstones: UPDATE_TOMBSTONES,
  copyReattributedDetections: COPY_REATTRIBUTED_DETECTIONS,
  deleteAbsorbedClusters: DELETE_ABSORBED_CLUSTERS,
  updateReignitionLinks: UPDATE_REIGNITION_LINKS,
  updateEventAggregates: UPDATE_EVENT_AGGREGATES,
  updateClusterAggregates: UPDATE_CLUSTER_AGGREGATES,
  insertLedgerEntry: INSERT_LEDGER_ENTRY,
  selectTickEvents: SELECT_TICK_EVENTS,
  updateCarries: UPDATE_CARRIES,
  updateTickedAt: UPDATE_TICKED_AT,
});

type Row = Record<string, unknown>;

/**
 * @param config the one parameter set this store writes under. `liveRun` refuses any
 * other, and the hull diameter is converted from the core's integer quanta with this
 * set's metric — the quantum the core measured in.
 */
export function createPgClusteringStore(
  pool: PgClusteringPool,
  config: ClusteringConfig,
): ClusteringStore {
  const quantumKm = config.values.metric.quantumKm;

  async function inTransaction<T>(
    work: (client: PgClusteringClient) => Promise<T | typeof SKIP>,
  ): Promise<T | typeof SKIP> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query(value === SKIP ? 'ROLLBACK' : 'COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async liveRun(requested: ClusteringConfig): Promise<ClusteringRun> {
      if (requested.version !== config.version || requested.digest !== config.digest) {
        throw new Error(
          `the clustering store was built for ${config.version} (${config.digest}) and was ` +
            `asked for ${requested.version} (${requested.digest})`,
        );
      }
      const run = await inTransaction(async (client) => {
        await client.query(LOCK_LIVE_RUNS, [LIVE_RUN_LOCK_KEY]);
        const { rows } = await client.query<Row>(SELECT_LIVE_RUNS);
        if (rows.length > 1) {
          throw new Error(
            `${String(rows.length)} live clustering runs exist; exactly one is expected, and ` +
              'which one continues is a D7 promotion decision, not the worker’s',
          );
        }
        const [existing] = rows;
        if (existing !== undefined) return decodeRun(existing);
        const inserted = await client.query<Row>(INSERT_LIVE_RUN, [
          config.version,
          config.digest,
          canonicalJson(config.values),
        ]);
        const [row] = inserted.rows;
        if (row === undefined) throw new Error('clustering_runs insert returned no row');
        return decodeRun(row);
      });
      if (run === SKIP) throw new Error('unreachable: liveRun never skips');
      if (run.configVersion !== config.version || run.configDigest !== config.digest) {
        // Changing parameters under a running registry is a D7 promotion (offline run,
        // diff, ratified switch). Continuing the old run with new parameters would stamp
        // new events with a version the run never used.
        throw new Error(
          `the live clustering run ${String(run.id)} was produced under ${run.configVersion} ` +
            `(${run.configDigest}); this worker runs ${config.version} (${config.digest}). ` +
            'A parameter change is a D7 promotion, not a restart.',
        );
      }
      return run;
    },

    async pendingBatches(
      run: ClusteringRun,
      query: PendingBatchQuery,
    ): Promise<readonly PendingBatch[]> {
      if (!Number.isInteger(query.limit) || query.limit < 1) {
        throw new RangeError(`limit must be a positive integer, got ${String(query.limit)}`);
      }
      const client = await pool.connect();
      try {
        const { rows } = await client.query<Row>(SELECT_PENDING_BATCHES, [
          run.id,
          isoFromEpochMs(query.notBefore),
          query.limit,
        ]);
        return rows.map((row) => ({
          source: assertSourceId(string(field(row, 'source'), 'source')),
          availableAt: epochMs(field(row, 'available_at'), 'available_at'),
        }));
      } finally {
        client.release();
      }
    },

    async withBatch<T>(
      run: ClusteringRun,
      batch: PendingBatch,
      work: (tx: BatchTransaction) => Promise<T>,
    ): Promise<T | null> {
      const value = await inTransaction<T>(async (client) => {
        await client.query(LOCK_RUN, [run.id]);
        const ledger = await client.query<Row>(SELECT_LEDGER_ENTRY, [
          run.id,
          isoFromEpochMs(batch.availableAt),
          batch.source,
        ]);
        // Another writer applied it between our `pendingBatches` and the lock: skip, and
        // roll back the (read-only) transaction rather than commit nothing.
        if (ledger.rows.length > 0) return SKIP;
        return work(batchTransaction(client, run, batch, quantumKm));
      });
      return value === SKIP ? null : value;
    },

    async withTick<T>(run: ClusteringRun, work: (tx: TickTransaction) => Promise<T>): Promise<T> {
      const value = await inTransaction<T>(async (client) => {
        const { rows } = await client.query<Row>(LOCK_RUN, [run.id]);
        const [locked] = rows;
        if (locked === undefined) {
          throw new Error(`clustering run ${String(run.id)} does not exist`);
        }
        const ticked = field(locked, 'lifecycle_ticked_at');
        return work(
          tickTransaction(
            client,
            run,
            ticked === null ? null : epochMs(ticked, 'lifecycle_ticked_at'),
          ),
        );
      });
      if (value === SKIP) throw new Error('unreachable: a tick never skips');
      return value;
    },
  };
}

/** Sentinel for "roll back and report skipped"; never a value `work` can return. */
const SKIP: unique symbol = Symbol('skip');

function batchTransaction(
  client: PgClusteringClient,
  run: ClusteringRun,
  batch: PendingBatch,
  quantumKm: number,
): BatchTransaction {
  let applied = false;
  const alertStates = createPgAlertStateStore(client);

  return {
    async loadDetections(): Promise<readonly ClusteringDetection[]> {
      const { rows } = await client.query<Row>(SELECT_BATCH_DETECTIONS, [
        isoFromEpochMs(batch.availableAt),
        batch.source,
      ]);
      return rows.map((row) => ({
        detectionUid: string(field(row, 'detection_uid'), 'detection_uid'),
        source: assertSourceId(string(field(row, 'source'), 'source')),
        availableAt: epochMs(field(row, 'available_at'), 'available_at'),
        acqTsIso: isoFromEpochMs(epochMs(field(row, 'acq_ts'), 'acq_ts')),
        latCanonical: string(field(row, 'lat'), 'lat'),
        lonCanonical: string(field(row, 'lon'), 'lon'),
        scanKm: nullableNumber(field(row, 'scan_km'), 'scan_km'),
        trackKm: nullableNumber(field(row, 'track_km'), 'track_km'),
      }));
    },

    async loadWorkingSet(activeSince: EpochMs): Promise<StoredWorkingSet> {
      const [clusters, next, ids] = [
        await client.query<Row>(SELECT_WORKING_SET, [run.id, isoFromEpochMs(activeSince)]),
        await client.query<Row>(SELECT_NEXT_CLUSTER_ID),
        await client.query<Row>(SELECT_PUBLIC_IDS),
      ];
      const [nextRow] = next.rows;
      if (nextRow === undefined) throw new Error('next cluster id query returned no row');
      return {
        clusters: groupClusters(clusters.rows),
        nextClusterId: seqFrom(field(nextRow, 'next_id'), 'next_id'),
        takenPublicIds: ids.rows.map((row) => string(field(row, 'public_id'), 'public_id')),
      };
    },

    async loadAliases(): Promise<AliasLinks> {
      const { rows } = await client.query<Row>(SELECT_ALIASES);
      return new Map(
        rows.map((row) => [
          string(field(row, 'tombstone'), 'tombstone'),
          string(field(row, 'survivor'), 'survivor'),
        ]),
      );
    },

    loadAlertStates(publicIds) {
      return alertStates.loadStatesForEvents(publicIds);
    },

    async loadScoringDetections(
      keys: readonly ScoringDetectionKey[],
    ): Promise<readonly ScoringDetection[]> {
      if (keys.length === 0) return [];
      const { rows } = await client.query<Row>(SELECT_SCORING_DETECTIONS, [
        keys.map((k) => k.detectionUid),
        keys.map((k) => k.acqTsIso),
      ]);
      return rows.map(decodeScoringDetection);
    },

    async loadCandidates(
      queries: readonly ReignitionQuery[],
    ): Promise<readonly ReignitionCandidateEvent[]> {
      if (queries.length === 0) return [];
      const { rows } = await client.query<Row>(SELECT_REIGNITION_CANDIDATES, [
        run.id,
        queries.map((q) => q.at.lat),
        queries.map((q) => q.at.lon),
        queries.map((q) => q.radiusKm * 1000 + CANDIDATE_MARGIN_M),
        queries.map((q) => isoFromEpochMs(q.notBefore)),
        queries.map((q) => isoFromEpochMs(q.notAfter)),
      ]);
      return rows.map((row) => ({
        clusterId: seqFrom(field(row, 'cluster_id'), 'cluster_id'),
        publicId: string(field(row, 'public_id'), 'public_id'),
        centroid: { lat: number(field(row, 'lat'), 'lat'), lon: number(field(row, 'lon'), 'lon') },
        startedAt: epochMs(field(row, 'started_at'), 'started_at'),
        lastDetectionAt: epochMs(field(row, 'last_detection_at'), 'last_detection_at'),
        // No land-cover column or classifier exists; `null` is rule 5's middle band.
        fuelBand: null,
      }));
    },

    async applyBatch(write: BatchWrite): Promise<void> {
      if (applied) throw new Error('applyBatch called twice in one batch transaction');
      applied = true;
      await applyWrite(client, run, write, quantumKm);
    },
  };
}

/** The ten steps of one batch write, in the order the port's contract lays out. */
async function applyWrite(
  client: PgClusteringClient,
  run: ClusteringRun,
  { batch, result, writes, scores }: BatchWrite,
  quantumKm: number,
): Promise<void> {
  // 1. Seeds, one statement each in ascending engine id, so identity values are drawn in
  //    that order (module docblock). An absorbed seed gets its registry row — its id
  //    must resolve forever (I1) — and no working-set row.
  for (const seeded of writes.seededEvents) {
    const initial = seeded.initial;
    const inserted = await client.query<Row>(INSERT_SEEDED_EVENT, [
      initial.publicId,
      isoFromEpochMs(seeded.mintedAt),
      initial.startedAtIso,
      initial.lastDetectionAtIso,
      initial.centroidLatCanonical,
      initial.centroidLonCanonical,
      hullWkt(initial.hull),
      initial.hullDiameterQuanta * quantumKm,
      initial.needsReview,
      initial.detectionCount,
      canonicalJson(initial.sourceMix),
      seeded.configVersion,
      seeded.sourceRegistryVersion,
    ]);
    const [row] = inserted.rows;
    if (row === undefined)
      throw new Error(`fire_events insert of ${initial.publicId} returned no row`);
    if (seeded.absorbed) continue;
    await client.query(INSERT_CLUSTER, [
      run.id,
      seqFrom(field(row, 'id'), 'id'),
      initial.centroidLatCanonical,
      initial.centroidLonCanonical,
      hullWkt(initial.hull),
      initial.startedAtIso,
      initial.lastDetectionAtIso,
      initial.detectionCount,
      seeded.seedDetectionUid,
      isoFromEpochMs(seeded.mintedAt),
    ]);
  }

  // 2. Assignments, each onto the event it belongs to once the batch commits: a detection
  //    that joined a cluster a later detection of the same batch merged away belongs to
  //    the survivor.
  if (result.assignments.length > 0) {
    const assignments = result.assignments;
    await expectCount(
      client,
      INSERT_ASSIGNMENTS,
      [
        run.id,
        assignments.map((a) => canonicalPublicId(writes.merge.aliases, a.publicId)),
        assignments.map((a) => a.detectionUid),
        assignments.map((a) => a.acqTsIso),
      ],
      assignments.length,
      'event_detections assignment',
    );
  }

  // 3–4. New tombstones, then the existing ones whose chain this merge shortened. Both are
  //      the same column write; the trigger bumps `seq` because `merged_into` is projected.
  const redirects = [
    ...writes.merge.tombstones.map((t) => [t.publicId, t.mergedIntoPublicId] as const),
    ...writes.merge.aliasRewrites.map((r) => [r.publicId, r.to] as const),
  ];
  if (redirects.length > 0) {
    await expectCount(
      client,
      UPDATE_TOMBSTONES,
      [redirects.map(([from]) => from), redirects.map(([, to]) => to)],
      redirects.length,
      'tombstone',
    );
  }

  // 5. Re-attribution, as a copy (module docblock).
  const moves = writes.merge.detectionReattributions;
  if (moves.length > 0) {
    await client.query(COPY_REATTRIBUTED_DETECTIONS, [
      run.id,
      moves.map((m) => m.fromPublicId),
      moves.map((m) => m.toPublicId),
    ]);
  }

  // 6. The absorbed clusters leave the working set.
  if (writes.merge.tombstones.length > 0) {
    await client.query(DELETE_ABSORBED_CLUSTERS, [
      run.id,
      writes.merge.tombstones.map((t) => t.publicId),
    ]);
  }

  // 7. Alert state: the netted delete set, then the netted upsert set (the port's order).
  const alertStates = createPgAlertStateStore(client);
  await alertStates.remove(writes.alertStates.deletes);
  await alertStates.upsert(writes.alertStates.upserts);

  // 8. Reignition links. A link that updates nothing would be a claim silently lost.
  const links = writes.reignitionLinks;
  if (links.length > 0) {
    await expectCount(
      client,
      UPDATE_REIGNITION_LINKS,
      [
        links.map((l) => l.publicId),
        links.map((l) => l.relatedPublicId),
        links.map((l) => l.relationKind),
      ],
      links.length,
      'reignition link',
    );
  }

  // 9. Aggregates — and the D6 score, in the same statement — on both the registry row and
  //    the working-set row, from one set of arrays.
  if (writes.aggregates.length > 0) {
    const arrays = [run.id, ...aggregateArrays(writes.aggregates, scores, quantumKm)];
    await expectCount(
      client,
      UPDATE_EVENT_AGGREGATES,
      arrays,
      writes.aggregates.length,
      'event aggregate',
    );
    await expectCount(
      client,
      UPDATE_CLUSTER_AGGREGATES,
      arrays,
      writes.aggregates.length,
      'cluster aggregate',
    );
  }

  // 10. The ledger row, last: until it commits, the batch is pending.
  const stats = result.stats;
  await client.query(INSERT_LEDGER_ENTRY, [
    run.id,
    batch.source,
    isoFromEpochMs(batch.availableAt),
    stats.detections,
    stats.seeded,
    stats.attached,
    stats.merged,
    stats.unattached,
    stats.alreadyAssigned,
  ]);
}

function tickTransaction(
  client: PgClusteringClient,
  run: ClusteringRun,
  lastTickedAtMs: EpochMs | null,
): TickTransaction {
  return {
    lastTickedAtMs,

    async loadTickEvents(activeSince: EpochMs): Promise<readonly StoredTickEvent[]> {
      const { rows } = await client.query<Row>(SELECT_TICK_EVENTS, [
        run.id,
        isoFromEpochMs(activeSince),
      ]);
      const events: StoredTickEvent[] = [];
      let current: { head: Omit<StoredTickEvent, 'members'>; members: StoredMember[] } | null =
        null;
      for (const row of rows) {
        const publicId = string(field(row, 'public_id'), 'public_id');
        if (current === null || current.head.publicId !== publicId) {
          if (current !== null) events.push({ ...current.head, members: current.members });
          current = { head: decodeTickHead(row, publicId), members: [] };
        }
        current.members.push(decodeMember(row));
      }
      if (current !== null) events.push({ ...current.head, members: current.members });
      return events;
    },

    events: createPgEventStatusStore(client),

    async saveCarries(carries: readonly StoredCarry[]): Promise<void> {
      if (carries.length === 0) return;
      await expectCount(
        client,
        UPDATE_CARRIES,
        [
          carries.map((c) => c.publicId),
          carries.map((c) => c.missEvidence),
          carries.map((c) =>
            c.geoWeightSpent === null ? null : isoFromEpochMs(c.geoWeightSpent.utcDayStartMs),
          ),
          carries.map((c) => c.geoWeightSpent?.weight ?? null),
          carries.map((c) =>
            c.seenDetectionAtMs === null ? null : isoFromEpochMs(c.seenDetectionAtMs),
          ),
          carries.map((c) => (c.blindSinceMs === null ? null : isoFromEpochMs(c.blindSinceMs))),
        ],
        carries.length,
        'lifecycle carry',
      );
    },

    async markTicked(atMs: EpochMs): Promise<void> {
      await client.query(UPDATE_TICKED_AT, [run.id, isoFromEpochMs(atMs)]);
    },
  };
}

/**
 * Runs a write that must touch exactly `expected` rows. Every such statement joins by
 * public id; a short count means an id the plan named does not exist (or is a tombstone
 * where a live row was required), and committing the rest of the plan would publish a
 * registry the plan never described.
 */
async function expectCount(
  client: PgClusteringClient,
  text: string,
  values: readonly unknown[],
  expected: number,
  what: string,
): Promise<void> {
  const { rowCount } = await client.query(text, values);
  if (rowCount !== expected) {
    throw new Error(
      `${what} write touched ${String(rowCount)} rows, expected ${String(expected)}; ` +
        'the batch is rolled back and retried next cycle',
    );
  }
}

/**
 * One array per {@link AGGREGATE_UNNEST} column, `$2` onward. `scores` must name the same
 * events in the same order as `updates` (the port's contract); a misaligned pair would
 * write one event's score onto another, so it is checked rather than trusted.
 */
export function aggregateArrays(
  updates: readonly SurvivorUpdate[],
  scores: readonly EventScore[],
  quantumKm: number,
): readonly unknown[][] {
  if (
    scores.length !== updates.length ||
    scores.some((score, i) => score.publicId !== updates[i]?.publicId)
  ) {
    throw new Error(
      `${String(scores.length)} scores do not align with ${String(updates.length)} ` +
        'aggregates by public id; every rewritten event is scored, in aggregate order',
    );
  }
  return [
    updates.map((u) => u.publicId),
    updates.map((u) => u.startedAtIso),
    updates.map((u) => u.lastDetectionAtIso),
    updates.map((u) => u.detectionCount),
    updates.map((u) => canonicalJson(u.sourceMix)),
    updates.map((u) => Number(u.centroidLatCanonical)),
    updates.map((u) => Number(u.centroidLonCanonical)),
    updates.map((u) => hullWkt(u.hull)),
    updates.map((u) => u.hullDiameterQuanta * quantumKm),
    updates.map((u) => u.needsReview),
    scores.map((s) => s.score),
    scores.map((s) => s.paramsVersion),
    scores.map((s) => s.invalidated),
  ];
}

/**
 * The hull as a closed WKT ring, or `null` for a point or a segment — the case the
 * nullable `hull` column exists for (`SurvivorUpdate.hull`). `ST_GeomFromText(NULL)` is
 * NULL, so the statements need no branch.
 */
export function hullWkt(hull: readonly HullVertex[]): string | null {
  const [first] = hull;
  if (first === undefined || hull.length < 3) return null;
  const ring = [...hull, first].map((v) => `${v.lonCanonical} ${v.latCanonical}`);
  return `POLYGON((${ring.join(', ')}))`;
}

function decodeRun(row: unknown): ClusteringRun {
  const kind = string(field(row, 'kind'), 'kind');
  if (kind !== 'live' && kind !== 'offline') {
    throw new Error(`clustering_runs.kind holds a value outside live/offline: ${kind}`);
  }
  const ticked = field(row, 'lifecycle_ticked_at');
  return {
    id: seqFrom(field(row, 'id'), 'id'),
    kind,
    configVersion: string(field(row, 'config_version'), 'config_version'),
    configDigest: string(field(row, 'config_digest'), 'config_digest'),
    lifecycleTickedAtMs: ticked === null ? null : epochMs(ticked, 'lifecycle_ticked_at'),
  };
}

function decodeMember(row: unknown): StoredMember {
  return {
    detectionUid: string(field(row, 'detection_uid'), 'detection_uid'),
    source: assertSourceId(string(field(row, 'source'), 'source')),
    acqTsIso: isoFromEpochMs(epochMs(field(row, 'acq_ts'), 'acq_ts')),
    latCanonical: string(field(row, 'lat'), 'lat'),
    lonCanonical: string(field(row, 'lon'), 'lon'),
    scanKm: nullableNumber(field(row, 'scan_km'), 'scan_km'),
    trackKm: nullableNumber(field(row, 'track_km'), 'track_km'),
    frpMw: nullableNumber(field(row, 'frp_mw'), 'frp_mw'),
  };
}

/** Rows of {@link SELECT_WORKING_SET}, ordered by cluster, folded into clusters. */
function groupClusters(rows: readonly unknown[]): StoredCluster[] {
  const clusters: StoredCluster[] = [];
  let current: { head: Omit<StoredCluster, 'members'>; members: StoredMember[] } | null = null;
  for (const row of rows) {
    const id = seqFrom(field(row, 'cluster_id'), 'cluster_id');
    if (current === null || current.head.id !== id) {
      if (current !== null) clusters.push({ ...current.head, members: current.members });
      current = {
        head: {
          id,
          publicId: string(field(row, 'public_id'), 'public_id'),
          seedDetectionUid: string(field(row, 'seed_detection_uid'), 'seed_detection_uid'),
          mintedAt: epochMs(field(row, 'minted_at'), 'minted_at'),
          configVersion: string(field(row, 'config_version'), 'config_version'),
          sourceRegistryVersion: string(
            field(row, 'source_registry_version'),
            'source_registry_version',
          ),
        },
        members: [],
      };
    }
    current.members.push(decodeMember(row));
  }
  if (current !== null) clusters.push({ ...current.head, members: current.members });
  return clusters;
}

function decodeTickHead(row: unknown, publicId: string): Omit<StoredTickEvent, 'members'> {
  const status = string(field(row, 'status'), 'status');
  if (!isLifecycleState(status)) {
    throw new Error(`fire_events.status holds a value outside the lifecycle: ${status}`);
  }
  const tier = string(field(row, 'display_tier'), 'display_tier');
  const displayTier = DISPLAY_TIERS.find(
    (candidate): candidate is DisplayTier => candidate === tier,
  );
  if (displayTier === undefined) {
    throw new Error(`fire_events.display_tier holds a value outside the tiers: ${tier}`);
  }
  const inactive = field(row, 'inactive_since');
  const day = field(row, 'geo_weight_day');
  const seen = field(row, 'lifecycle_seen_detection_at');
  const blind = field(row, 'lifecycle_blind_since');
  return {
    publicId,
    status,
    displayTier,
    inactiveSinceMs: inactive === null ? null : epochMs(inactive, 'inactive_since'),
    missEvidence: number(field(row, 'miss_evidence'), 'miss_evidence'),
    geoWeightSpent:
      day === null
        ? null
        : {
            utcDayStartMs: epochMs(day, 'geo_weight_day'),
            weight: number(field(row, 'geo_weight_spent'), 'geo_weight_spent'),
          },
    blindSinceMs: blind === null ? null : epochMs(blind, 'lifecycle_blind_since'),
    seenDetectionAtMs: seen === null ? null : epochMs(seen, 'lifecycle_seen_detection_at'),
  };
}

function decodeScoringDetection(row: unknown): ScoringDetection {
  const confidence = string(field(row, 'confidence'), 'confidence');
  if (confidence !== 'low' && confidence !== 'nominal' && confidence !== 'high') {
    throw new Error(`detections.confidence holds a value outside the mapping: ${confidence}`);
  }
  const dayNight = field(row, 'day_night');
  if (dayNight !== null && dayNight !== 'D' && dayNight !== 'N') {
    throw new Error(`detections.day_night holds a value outside D/N: ${JSON.stringify(dayNight)}`);
  }
  return {
    detectionUid: string(field(row, 'detection_uid'), 'detection_uid'),
    source: assertSourceId(string(field(row, 'source'), 'source')),
    acqTsIso: isoFromEpochMs(epochMs(field(row, 'acq_ts'), 'acq_ts')),
    latCanonical: string(field(row, 'lat'), 'lat'),
    lonCanonical: string(field(row, 'lon'), 'lon'),
    confidence,
    dayNight,
    frpMw: nullableNumber(field(row, 'frp_mw'), 'frp_mw'),
    scanKm: nullableNumber(field(row, 'scan_km'), 'scan_km'),
    trackKm: nullableNumber(field(row, 'track_km'), 'track_km'),
    // No land-cover layer is consulted; the §3.6 guard keeps a detection nobody asked about.
    overOrAdjacentToWater: null,
  };
}

function nullableNumber(value: unknown, name: string): number | null {
  return value === null ? null : number(value, name);
}
