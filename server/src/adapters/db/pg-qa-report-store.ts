/**
 * The weekly QA report's inputs and record over Postgres (TASKS D8; migration 011).
 *
 * Two reads of the pipeline's tables and two statements on `qa_weekly_reports`. The
 * inclusion rules live on the port (`core/ports/qa-report-store.ts`); this module is those
 * rules in SQL and the decoding of what comes back.
 *
 * ## PLB traces
 *
 * One row per non-SP detection that arrived in the window, with the earliest attachment
 * over **live** clustering runs as a correlated `MIN` — a detection is attached once per
 * run, and every hourly live run re-attaches it, so the first attachment is the one the
 * pipeline's latency is measured to. The subquery is keyed on `(detection_uid, acq_ts)`,
 * the detection's own key, so it hits the partition the detection lives in.
 *
 * ## DAR alerts, merge-resolved
 *
 * `alert_outbox` names the event row the alert was decided on; after a merge that row is
 * absorbed and its public id is not the fire a reader recognises. A recursive CTE follows
 * `merged_into` to its end. The chain is bounded at `MAX_MERGE_DEPTH` hops: a merge cycle
 * cannot be written by the merge path, but if one ever were, the query returns the row
 * still pointing somewhere and the decoder throws rather than guessing a survivor.
 *
 * ## Refusing a changed digest
 *
 * As in `pg-lag-histogram-store.ts`: `ON CONFLICT … DO UPDATE … WHERE` both stored digests
 * equal the new ones, and a zero row count means a config edited in place under an
 * unchanged version, which throws.
 */

import { isLifecycleState, type LifecycleState } from '@fire-watch/contracts';

import { ALERT_TYPES, type AlertType } from '../../core/config/alert-gating.js';
import type {
  QaAlertRow,
  QaReportInputReader,
  QaReportStore,
  StoredWeeklyReport,
} from '../../core/ports/qa-report-store.js';
import type {
  QaLifecycleHistory,
  QaLifecyclePopulationRow,
  QaTransitionRow,
} from '../../core/qa/lifecycle-metrics.js';
import type { PipelineTrace } from '../../core/qa/shadow-plb.js';
import { boolean, epochMs, field, number, string } from './pg-rows.js';

/** The slice of `pg` this module uses. */
export interface PgQaReportQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export const MAX_MERGE_DEPTH = 32;

// COLLATE "C": the core orders by UTF-16 code units, and the database collation would not.
const SELECT_PLB_TRACES = `
SELECT d.detection_uid, d.available_at, d.ingested_at,
       (SELECT min(ed.attached_at)
          FROM event_detections ed
          JOIN clustering_runs r ON r.id = ed.clustering_run_id AND r.kind = 'live'
         WHERE ed.detection_uid = d.detection_uid AND ed.acq_ts = d.acq_ts) AS event_updated_at
FROM detections d
WHERE d.available_at >= $1::timestamptz AND d.available_at < $2::timestamptz
  AND d.product_tier <> 'SP'
ORDER BY d.detection_uid COLLATE "C"
`.trim();

const SELECT_DAR_ALERTS = `
WITH RECURSIVE chain AS (
  SELECT o.id AS alert_id, o.watch_zone_id, o.alert_type, o.alert_subkey, o.decided_at,
         e.public_id, e.merged_into, 0 AS depth
  FROM alert_outbox o
  JOIN fire_events e ON e.id = o.fire_event_id
  WHERE o.decided_at >= $1::timestamptz AND o.decided_at < $2::timestamptz
    AND o.trigger_type <> 'manual'
  UNION ALL
  SELECT c.alert_id, c.watch_zone_id, c.alert_type, c.alert_subkey, c.decided_at,
         m.public_id, m.merged_into, c.depth + 1
  FROM chain c
  JOIN fire_events m ON m.id = c.merged_into
  WHERE c.depth < ${String(MAX_MERGE_DEPTH)}
)
SELECT DISTINCT ON (alert_id)
       alert_id::text AS alert_id, watch_zone_id::text AS zone_id, public_id AS event_key,
       alert_type, alert_subkey, decided_at, (merged_into IS NULL) AS resolved
FROM chain
ORDER BY alert_id, depth DESC
`.trim();

const SELECT_LOG_ORIGIN = `SELECT started_at FROM lifecycle_log_origin WHERE id = 1`;

// $1 = lead-in start, $2 = window end. Creation rows included; the core decides what they
// mean to each metric. Ordered for byte-stable reports.
const SELECT_TRANSITIONS = `
SELECT e.public_id, t.transitioned_at, t.from_status, t.to_status, t.status_reason,
       t.max_frp_mw, t.hull_area_ha, (e.merged_into IS NOT NULL) AS merged,
       CASE WHEN t.to_status = 'no_longer_detected' THEN (
         SELECT min(ed.attached_at)
           FROM event_detections ed
           JOIN clustering_runs r ON r.id = ed.clustering_run_id AND r.kind = 'live'
          WHERE ed.fire_event_id = t.fire_event_id AND ed.attached_at > t.transitioned_at
       ) END AS reattached_at
FROM fire_event_transitions t
JOIN fire_events e ON e.id = t.fire_event_id
WHERE t.transitioned_at >= $1::timestamptz AND t.transitioned_at < $2::timestamptz
ORDER BY e.public_id COLLATE "C", t.transitioned_at, t.id
`.trim();

// $1 = lead-in start, $2 = window start, $3 = window end. FLR's population: events not
// merged away that moved in [lead-in, end) or stood \`active\` at the window start.
const SELECT_LIFECYCLE_POPULATION = `
WITH ev AS (
  SELECT e.public_id,
         coalesce(
           (SELECT t.to_status FROM fire_event_transitions t
             WHERE t.fire_event_id = e.id AND t.transitioned_at < $2::timestamptz
             ORDER BY t.transitioned_at DESC, t.id DESC LIMIT 1),
           CASE WHEN EXISTS (SELECT 1 FROM fire_event_transitions t
                              WHERE t.fire_event_id = e.id AND t.transitioned_at >= $2::timestamptz)
                THEN (SELECT coalesce(t.from_status, '<none>') FROM fire_event_transitions t
                       WHERE t.fire_event_id = e.id AND t.transitioned_at >= $2::timestamptz
                       ORDER BY t.transitioned_at, t.id LIMIT 1)
                ELSE e.status END
         ) AS status_at_start,
         EXISTS (SELECT 1 FROM fire_event_transitions t
                  WHERE t.fire_event_id = e.id
                    AND t.transitioned_at >= $1::timestamptz
                    AND t.transitioned_at < $3::timestamptz) AS moved
  FROM fire_events e
  WHERE e.merged_into IS NULL
)
SELECT public_id, NULLIF(status_at_start, '<none>') AS status_at_start
FROM ev
WHERE moved OR status_at_start = 'active'
ORDER BY public_id COLLATE "C"
`.trim();

const SELECT_HAS_REPORT = `
SELECT 1 AS present FROM qa_weekly_reports
WHERE iso_week = $1 AND metrics_version = $2 AND report_version = $3
`.trim();

const UPSERT_REPORT = `
INSERT INTO qa_weekly_reports AS r (
  iso_week, window_start, window_end, metrics_version, metrics_digest,
  report_version, report_digest, generated_at, report_json, report_markdown
) VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8::timestamptz, $9, $10)
ON CONFLICT (iso_week, metrics_version, report_version) DO UPDATE SET
  window_start    = EXCLUDED.window_start,
  window_end      = EXCLUDED.window_end,
  generated_at    = EXCLUDED.generated_at,
  report_json     = EXCLUDED.report_json,
  report_markdown = EXCLUDED.report_markdown,
  written_at      = now()
WHERE r.metrics_digest = EXCLUDED.metrics_digest AND r.report_digest = EXCLUDED.report_digest
`.trim();

/** Exported for the unit test, which asserts on statement text. */
export const QA_REPORT_SQL = Object.freeze({
  selectPlbTraces: SELECT_PLB_TRACES,
  selectDarAlerts: SELECT_DAR_ALERTS,
  selectHasReport: SELECT_HAS_REPORT,
  selectLogOrigin: SELECT_LOG_ORIGIN,
  selectTransitions: SELECT_TRANSITIONS,
  selectLifecyclePopulation: SELECT_LIFECYCLE_POPULATION,
  upsertReport: UPSERT_REPORT,
});

const iso = (ms: number): string => new Date(ms).toISOString();

export function createPgQaReportStore(
  db: PgQaReportQueryable,
): QaReportInputReader & QaReportStore {
  return {
    async loadPlbTraces({ fromMs, toMs }) {
      const { rows } = await db.query(SELECT_PLB_TRACES, [iso(fromMs), iso(toMs)]);
      return rows.map(decodePlbTrace);
    },

    async loadDarAlerts({ fromMs, toMs }) {
      const { rows } = await db.query(SELECT_DAR_ALERTS, [iso(fromMs), iso(toMs)]);
      return rows.map(decodeDarAlert);
    },

    async loadLifecycleHistory({ fromMs, toMs, leadInMs }): Promise<QaLifecycleHistory> {
      const leadInFrom = iso(fromMs - leadInMs);
      const [origin, transitions, population] = await Promise.all([
        db.query(SELECT_LOG_ORIGIN),
        db.query(SELECT_TRANSITIONS, [leadInFrom, iso(toMs)]),
        db.query(SELECT_LIFECYCLE_POPULATION, [leadInFrom, iso(fromMs), iso(toMs)]),
      ]);
      const [originRow] = origin.rows;
      return {
        logStartedAtMs:
          originRow === undefined ? null : epochMs(field(originRow, 'started_at'), 'started_at'),
        transitions: transitions.rows.map(decodeTransition),
        population: population.rows.map(decodePopulationRow),
      };
    },

    async has({ isoWeek, metricsVersion, reportVersion }) {
      const { rows } = await db.query(SELECT_HAS_REPORT, [isoWeek, metricsVersion, reportVersion]);
      return rows.length > 0;
    },

    async save(report) {
      const { rowCount } = await db.query(UPSERT_REPORT, saveParameters(report));
      if ((rowCount ?? 0) !== 1) {
        throw new Error(
          `qa_weekly_reports: ${report.isoWeek} not written — a stored row has the same ` +
            `metrics version (${report.metricsVersion}) and report version ` +
            `(${report.reportVersion}) under a different digest (a config edited in place?)`,
        );
      }
    },
  };
}

/** The ten parameters of `UPSERT_REPORT`, in placeholder order. */
export function saveParameters(report: StoredWeeklyReport): unknown[] {
  return [
    report.isoWeek,
    iso(report.fromMs),
    iso(report.toMs),
    report.metricsVersion,
    report.metricsDigest,
    report.reportVersion,
    report.reportDigest,
    iso(report.generatedAtMs),
    report.reportJson,
    report.reportMarkdown,
  ];
}

export function decodePlbTrace(row: unknown): PipelineTrace {
  const eventUpdated = field(row, 'event_updated_at');
  return {
    traceId: string(field(row, 'detection_uid'), 'detection_uid'),
    availableAtMs: epochMs(field(row, 'available_at'), 'available_at'),
    ingestedAtMs: epochMs(field(row, 'ingested_at'), 'ingested_at'),
    eventUpdatedAtMs: eventUpdated === null ? null : epochMs(eventUpdated, 'event_updated_at'),
    decidedAtMs: null,
    providerAckAtMs: null,
    providerChannel: null,
    broadcastAtMs: null,
  };
}

export function decodeDarAlert(row: unknown): QaAlertRow {
  const alertId = string(field(row, 'alert_id'), 'alert_id');
  if (!boolean(field(row, 'resolved'), 'resolved')) {
    throw new Error(
      `alert ${alertId}: its event's merge chain does not end within ` +
        `${String(MAX_MERGE_DEPTH)} hops (a merge cycle?)`,
    );
  }
  return {
    alertId,
    zoneId: string(field(row, 'zone_id'), 'zone_id'),
    eventKey: string(field(row, 'event_key'), 'event_key'),
    alertType: alertType(field(row, 'alert_type')),
    alertSubkey: string(field(row, 'alert_subkey'), 'alert_subkey'),
    decidedAtMs: epochMs(field(row, 'decided_at'), 'decided_at'),
  };
}

function alertType(value: unknown): AlertType {
  const text = string(value, 'alert_type');
  const known = ALERT_TYPES.find((type) => type === text);
  if (known === undefined) throw new Error(`alert_type ${JSON.stringify(text)} is not known`);
  return known;
}

export function decodeTransition(row: Record<string, unknown>): QaTransitionRow {
  const from = field(row, 'from_status');
  const reason = field(row, 'status_reason');
  const reattached = field(row, 'reattached_at');
  return {
    publicId: string(field(row, 'public_id'), 'public_id'),
    atMs: epochMs(field(row, 'transitioned_at'), 'transitioned_at'),
    from: from === null ? null : lifecycleState(from, 'from_status'),
    to: lifecycleState(field(row, 'to_status'), 'to_status'),
    reason: reason === null ? null : string(reason, 'status_reason'),
    maxFrpMw: optionalNumber(field(row, 'max_frp_mw'), 'max_frp_mw'),
    hullAreaHa: optionalNumber(field(row, 'hull_area_ha'), 'hull_area_ha'),
    merged: boolean(field(row, 'merged'), 'merged'),
    reattachedAtMs: reattached === null ? null : epochMs(reattached, 'reattached_at'),
  };
}

export function decodePopulationRow(row: Record<string, unknown>): QaLifecyclePopulationRow {
  const status = field(row, 'status_at_start');
  return {
    publicId: string(field(row, 'public_id'), 'public_id'),
    statusAtStart: status === null ? null : lifecycleState(status, 'status_at_start'),
  };
}

function lifecycleState(value: unknown, name: string): LifecycleState {
  if (!isLifecycleState(value)) throw new Error(`${name} is not a lifecycle state`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | null {
  return value === null ? null : number(value, name);
}
