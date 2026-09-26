/**
 * Every `fw_*` series this system exports, in one list (TASKS C5, the Grafana Cloud leg;
 * OPERATIONS §3; review 04 §5.3.1).
 *
 * The descriptors declared elsewhere — the alert deferral metrics (A1.12) and the backup
 * table gauges (C6) — are collected here rather than restated, so that a rename there is a
 * rename here. {@link METRIC_CATALOG} is what the exposition validates against, and what
 * the `infra/metrics/rules` test checks every alert expression against: a rule that names a
 * series not in this list is a rule that can never fire, and fails the build instead.
 *
 * Alongside the descriptors live the pure functions that turn a loop's existing report into
 * samples. None of them changes what a loop does; each reads the report the loop already
 * hands its reporter.
 *
 * Label vocabulary, and why:
 *
 *   * `row` — a freshness budget row id (`firms:viirs:snpp`, `effis-refresh`, …), the key of
 *     `freshness_budgets_v1`. One label for sources and jobs alike, because the budget table
 *     is one table and the alert rules join on it.
 *   * `job_id` — a heartbeat job id. Not `job`: the scraper owns `job`, and a target label
 *     of that name is silently renamed `exported_job`.
 *   * `loop` — a worker loop name, as in the worker's `stopped` line.
 *   * `reason` — a closed vocabulary per family: {@link SSE_REJECT_REASONS} for stream
 *     refusals, A1.12's `ALERT_DROP_REASONS` / `ALERT_DEFERRAL_REASONS` for alert sends.
 *   * No label ever carries a user identifier, a zone, an address or a free-text error
 *     (EXTERNAL-ACCOUNTS row 10): every label value comes from a closed vocabulary.
 */

import { FRESHNESS_STATES, type FreshnessReport, type HeartbeatJobId } from '@fire-watch/contracts';

import type { TableGauge } from '../backup/table-gauges.js';
import {
  BACKUP_TABLE_BYTES,
  BACKUP_TABLE_METRICS,
  BACKUP_TABLE_ROWS,
} from '../backup/table-gauges.js';
import type { IngestCycleReport } from '../ingest/ingest-cycle.js';
import { META_ALERT_KEYS, type MetaAlertKey } from '../monitoring/meta-alert-params.js';
import type { MonitorCycleReport } from '../monitoring/monitor-cycle.js';
import {
  ALERT_APPROVAL_PENDING_SECONDS,
  ALERT_DEFERRAL_METRICS,
  ALERT_DEFERRAL_REASONS,
  ALERT_DROP_REASONS,
  ALERT_SENDS_DEFERRED_TOTAL,
  ALERT_SENDS_DROPPED_TOTAL,
  type AlertDeferralReason,
  type AlertDropReason,
} from './alert-metrics.js';
import { validateCatalog, type MetricDescriptor, type MetricSample } from './prometheus-text.js';

// --- Freshness (API process, computed at scrape time from the same reader and budgets as
// --- `/api/health/freshness`) --------------------------------------------------------

export const FRESHNESS_LAST_SUCCESS: MetricDescriptor = {
  name: 'fw_freshness_last_success_timestamp_seconds',
  kind: 'gauge',
  help: 'Unix time of the last successful attempt of a freshness row; absent when it never succeeded.',
  labels: ['row'],
};

export const FRESHNESS_AGE: MetricDescriptor = {
  name: 'fw_freshness_age_seconds',
  kind: 'gauge',
  help: 'Seconds since the last successful attempt of a freshness row, as /api/health/freshness reports it.',
  labels: ['row'],
};

export const FRESHNESS_STATE: MetricDescriptor = {
  name: 'fw_freshness_state',
  kind: 'gauge',
  help: 'One-hot freshness verdict of a row under freshness_budgets: 1 for its current state, 0 for the others.',
  labels: ['row', 'state'],
};

export const FRESHNESS_BUDGET: MetricDescriptor = {
  name: 'fw_freshness_budget_seconds',
  kind: 'gauge',
  help: 'The warn and critical age budgets of a freshness row, from the shipped freshness_budgets table.',
  labels: ['row', 'band'],
};

export const FRESHNESS_PAGES: MetricDescriptor = {
  name: 'fw_freshness_pages',
  kind: 'gauge',
  help: '1 when a critical verdict on this row may page (OPERATIONS 1.2), 0 when it is informational.',
  labels: ['row'],
};

export const FRESHNESS_CONSECUTIVE_FAILURES: MetricDescriptor = {
  name: 'fw_freshness_consecutive_failures',
  kind: 'gauge',
  help: 'Consecutive failed attempts of a freshness row since its last success.',
  labels: ['row'],
};

export const FRESHNESS_BUDGET_VERSION: MetricDescriptor = {
  name: 'fw_freshness_budget_version_info',
  kind: 'gauge',
  help: 'Always 1; the label names the freshness budget table version the verdicts were computed under.',
  labels: ['version'],
};

export const FRESHNESS_COLLECTOR_UP: MetricDescriptor = {
  name: 'fw_freshness_collector_up',
  kind: 'gauge',
  help: '1 when the last scrape could read freshness observations from the database, 0 when it could not.',
  labels: [],
};

export const FRESHNESS_METRICS: readonly MetricDescriptor[] = [
  FRESHNESS_LAST_SUCCESS,
  FRESHNESS_AGE,
  FRESHNESS_STATE,
  FRESHNESS_BUDGET,
  FRESHNESS_PAGES,
  FRESHNESS_CONSECUTIVE_FAILURES,
  FRESHNESS_BUDGET_VERSION,
  FRESHNESS_COLLECTOR_UP,
];

// --- Jobs and loops (worker process; the backup CLI's textfile for nightly-backup) -------

export const JOB_LAST_SUCCESS: MetricDescriptor = {
  name: 'fw_job_last_success_timestamp_seconds',
  kind: 'gauge',
  help: 'Unix time a job last reported success to its heartbeat, by heartbeat job id.',
  labels: ['job_id'],
};

export const LOOP_RUNS: MetricDescriptor = {
  name: 'fw_loop_runs_total',
  kind: 'counter',
  help: 'Worker loop runs since process start, by loop and by whether the run threw.',
  labels: ['loop', 'outcome'],
};

export const LOOP_LAST_FINISHED: MetricDescriptor = {
  name: 'fw_loop_last_finished_timestamp_seconds',
  kind: 'gauge',
  help: 'Unix time the last run of a worker loop finished, whether or not it threw.',
  labels: ['loop'],
};

export const LOOP_LAST_DURATION: MetricDescriptor = {
  name: 'fw_loop_last_duration_seconds',
  kind: 'gauge',
  help: 'Wall-clock duration of the last run of a worker loop.',
  labels: ['loop'],
};

export const JOB_METRICS: readonly MetricDescriptor[] = [
  JOB_LAST_SUCCESS,
  LOOP_RUNS,
  LOOP_LAST_FINISHED,
  LOOP_LAST_DURATION,
];

// --- Ingest (worker process, from the ingest cycle's report) -----------------------------

export const SOURCE_FETCH: MetricDescriptor = {
  name: 'fw_source_fetch_total',
  kind: 'counter',
  help: 'Per-source ingest attempts since process start, by outcome of the attempt.',
  labels: ['source', 'outcome'],
};

export const SOURCE_RECORDS_FETCHED: MetricDescriptor = {
  name: 'fw_source_records_fetched_total',
  kind: 'counter',
  help: 'Detections a source produced since process start, after within-batch de-duplication.',
  labels: ['source'],
};

export const SOURCE_RECORDS_INSERTED: MetricDescriptor = {
  name: 'fw_source_records_inserted_total',
  kind: 'counter',
  help: 'Detections from a source newly inserted since process start.',
  labels: ['source'],
};

export const INGEST_METRICS: readonly MetricDescriptor[] = [
  SOURCE_FETCH,
  SOURCE_RECORDS_FETCHED,
  SOURCE_RECORDS_INSERTED,
];

// --- Meta-alert readings (worker process, from the J1 monitors loop) ---------------------

export const NOTIFICATION_QUEUE_OLDEST: MetricDescriptor = {
  name: 'fw_notification_queue_oldest_seconds',
  kind: 'gauge',
  help: 'Age in seconds of the oldest unsent outbox row (GATES L-8); 0 when the queue is empty.',
  labels: [],
};

export const NOTIFICATION_QUEUE_DEPTH: MetricDescriptor = {
  name: 'fw_notification_queue_depth',
  kind: 'gauge',
  help: 'Outbox rows pending dispatch.',
  labels: [],
};

export const NOTIFICATION_QUEUE_CLAIMED: MetricDescriptor = {
  name: 'fw_notification_queue_claimed',
  kind: 'gauge',
  help: 'Outbox rows claimed by a dispatcher and not yet settled.',
  labels: [],
};

export const NOTIFICATION_QUEUE_CLAIMED_OLDEST: MetricDescriptor = {
  name: 'fw_notification_queue_claimed_oldest_seconds',
  kind: 'gauge',
  help: 'Age in seconds of the oldest claimed outbox row; 0 when none is claimed.',
  labels: [],
};

export const IDENTITY_PENDING_BATCHES: MetricDescriptor = {
  name: 'fw_identity_pending_batches',
  kind: 'gauge',
  help: 'Ingested batches the identity loop has not processed yet; absent unless exactly one run is live.',
  labels: [],
};

export const IDENTITY_OLDEST_PENDING: MetricDescriptor = {
  name: 'fw_identity_oldest_pending_seconds',
  kind: 'gauge',
  help: 'Age in seconds of the oldest batch the identity loop has not processed; absent unless exactly one run is live.',
  labels: [],
};

export const CANARY_ROUND_TRIP: MetricDescriptor = {
  name: 'fw_canary_round_trip_seconds',
  kind: 'gauge',
  help: 'Seconds the in-flight dispatch canary has been outstanding or took to round-trip; absent while no canary exists.',
  labels: [],
};

export const META_ALERT_PAGING: MetricDescriptor = {
  name: 'fw_meta_alert_paging',
  kind: 'gauge',
  help: '1 while a meta-alert key is paging after hysteresis, 0 otherwise.',
  labels: ['key'],
};

/**
 * Which series each monitor reading feeds. A `Record` over the key type, so a new key in
 * `META_ALERT_KEYS` is a type error here until someone decides what it exports as.
 */
export const META_ALERT_SERIES: Readonly<Record<MetaAlertKey, MetricDescriptor>> = {
  outbox_queue_oldest_seconds: NOTIFICATION_QUEUE_OLDEST,
  outbox_pending_rows: NOTIFICATION_QUEUE_DEPTH,
  outbox_claimed_rows: NOTIFICATION_QUEUE_CLAIMED,
  outbox_claimed_oldest_seconds: NOTIFICATION_QUEUE_CLAIMED_OLDEST,
  outbox_awaiting_approval_oldest_seconds: ALERT_APPROVAL_PENDING_SECONDS,
  identity_pending_batches: IDENTITY_PENDING_BATCHES,
  identity_oldest_pending_seconds: IDENTITY_OLDEST_PENDING,
  canary_round_trip_seconds: CANARY_ROUND_TRIP,
};

export const META_ALERT_METRICS: readonly MetricDescriptor[] = [
  NOTIFICATION_QUEUE_OLDEST,
  NOTIFICATION_QUEUE_DEPTH,
  NOTIFICATION_QUEUE_CLAIMED,
  NOTIFICATION_QUEUE_CLAIMED_OLDEST,
  IDENTITY_PENDING_BATCHES,
  IDENTITY_OLDEST_PENDING,
  CANARY_ROUND_TRIP,
  META_ALERT_PAGING,
];

// --- Transport (API process, read at scrape time from fleet control; ADR-003, A1.1) -------

/**
 * Why the stream route refused a connect — the route's four refusals, in its order:
 * the fleet is demoted or the stream is switched off (`not_offered`, 503), the pump has not
 * seeded (`not_ready`, 503), the hub is full (`capacity`, 503), the client holds its share
 * (`client_cap`, 429).
 */
export const SSE_REJECT_REASONS = ['not_offered', 'not_ready', 'capacity', 'client_cap'] as const;
export type SseRejectReason = (typeof SSE_REJECT_REASONS)[number];

/**
 * The ADR-003 tiers this process can report. T2 — clients reading the CDN mirror because
 * this origin is down — is not among them: a process that is down exports nothing, so T2
 * shows as this series (and `up`) being absent, never as a 2.
 */
export const DEGRADATION_TIERS = { sse: 0, poll: 1 } as const;

export const DEGRADATION_TIER: MetricDescriptor = {
  name: 'fw_degradation_tier',
  kind: 'gauge',
  help: 'ADR-003 transport tier this API process offers: 0 stream (T0), 1 polling (T1); absent while the process is down (T2).',
  labels: [],
};

export const SSE_CONNECTIONS: MetricDescriptor = {
  name: 'fw_sse_connections',
  kind: 'gauge',
  help: 'Open event-stream connections held by this API process.',
  labels: [],
};

export const SSE_REJECTED: MetricDescriptor = {
  name: 'fw_sse_rejected_total',
  kind: 'counter',
  help: 'Event-stream connects refused since process start, by which admission check refused them.',
  labels: ['reason'],
};

export const TRANSPORT_METRICS: readonly MetricDescriptor[] = [
  DEGRADATION_TIER,
  SSE_CONNECTIONS,
  SSE_REJECTED,
];

// --- Process (API and worker alike, read at scrape time) ----------------------------------

export const EVENT_LOOP_LAG_P99: MetricDescriptor = {
  name: 'fw_event_loop_lag_p99_seconds',
  kind: 'gauge',
  help: 'p99 event-loop lag of this process since the previous scrape, net of the sampler resolution; absent when nothing was recorded.',
  labels: [],
};

export const PROCESS_METRICS: readonly MetricDescriptor[] = [EVENT_LOOP_LAG_P99];

/** The whole catalogue. Validated at module load: a malformed descriptor is a boot failure. */
export const METRIC_CATALOG: readonly MetricDescriptor[] = [
  ...FRESHNESS_METRICS,
  ...JOB_METRICS,
  ...INGEST_METRICS,
  ...META_ALERT_METRICS,
  ...ALERT_DEFERRAL_METRICS,
  ...BACKUP_TABLE_METRICS,
  ...TRANSPORT_METRICS,
  ...PROCESS_METRICS,
];
validateCatalog(METRIC_CATALOG);

// --- Report → samples ---------------------------------------------------------------------

/** The freshness verdict as series. Rows with no success omit the timestamp and the age. */
export function freshnessSamples(report: FreshnessReport): MetricSample[] {
  const samples: MetricSample[] = [
    { name: FRESHNESS_BUDGET_VERSION.name, labels: { version: report.budgetVersion }, value: 1 },
  ];
  for (const row of report.rows) {
    const labels = { row: row.row };
    if (row.lastSuccessAt !== null) {
      samples.push({
        name: FRESHNESS_LAST_SUCCESS.name,
        labels,
        value: Math.floor(Date.parse(row.lastSuccessAt) / 1000),
      });
    }
    if (row.ageSeconds !== null) {
      samples.push({ name: FRESHNESS_AGE.name, labels, value: row.ageSeconds });
    }
    for (const state of FRESHNESS_STATES) {
      samples.push({
        name: FRESHNESS_STATE.name,
        labels: { row: row.row, state },
        value: row.state === state ? 1 : 0,
      });
    }
    samples.push(
      {
        name: FRESHNESS_BUDGET.name,
        labels: { row: row.row, band: 'warn' },
        value: row.warnSeconds,
      },
      {
        name: FRESHNESS_BUDGET.name,
        labels: { row: row.row, band: 'critical' },
        value: row.criticalSeconds,
      },
      { name: FRESHNESS_PAGES.name, labels, value: row.pages ? 1 : 0 },
      { name: FRESHNESS_CONSECUTIVE_FAILURES.name, labels, value: row.consecutiveFailures },
    );
  }
  return samples;
}

/**
 * The monitors loop's readings as series. A `null` reading (no canary; identity not in
 * exactly one live run) is omitted, never exported as 0 — "no reading" and "healthy" are
 * different answers, and an alert rule must be able to tell them apart.
 */
export function metaAlertSamples(report: MonitorCycleReport): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const key of META_ALERT_KEYS) {
    const value = report.readings[key].value;
    if (value !== null) samples.push({ name: META_ALERT_SERIES[key].name, labels: {}, value });
    samples.push({
      name: META_ALERT_PAGING.name,
      labels: { key },
      value: report.paging.includes(key) ? 1 : 0,
    });
  }
  return samples;
}

export interface CounterIncrement {
  readonly descriptor: MetricDescriptor;
  readonly labels: Readonly<Record<string, string>>;
  readonly by: number;
}

/** What one ingest cycle adds to the per-source counters. */
export function ingestIncrements(report: IngestCycleReport): CounterIncrement[] {
  const increments: CounterIncrement[] = [];
  for (const result of report.sources) {
    increments.push(
      {
        descriptor: SOURCE_FETCH,
        labels: { source: result.source, outcome: result.outcome },
        by: 1,
      },
      {
        descriptor: SOURCE_RECORDS_FETCHED,
        labels: { source: result.source },
        by: result.received,
      },
      {
        descriptor: SOURCE_RECORDS_INSERTED,
        labels: { source: result.source },
        by: result.inserted,
      },
    );
  }
  return increments;
}

export interface TransportReading {
  readonly transport: keyof typeof DEGRADATION_TIERS;
  readonly connections: number;
  readonly rejected: Readonly<Record<SseRejectReason, number>>;
}

/**
 * Fleet control as series. Every reject reason is exported, zeros included, so that
 * `increase()` sees a counter's first refusal rather than a series appearing at 1.
 */
export function transportSamples(reading: TransportReading): MetricSample[] {
  return [
    { name: DEGRADATION_TIER.name, labels: {}, value: DEGRADATION_TIERS[reading.transport] },
    { name: SSE_CONNECTIONS.name, labels: {}, value: reading.connections },
    ...SSE_REJECT_REASONS.map((reason) => ({
      name: SSE_REJECTED.name,
      labels: { reason },
      value: reading.rejected[reason],
    })),
  ];
}

/** A lag reading in ms as the seconds gauge; no reading, no sample. */
export function eventLoopLagSamples(p99Ms: number | null): MetricSample[] {
  if (p99Ms === null || !Number.isFinite(p99Ms)) return [];
  return [{ name: EVENT_LOOP_LAG_P99.name, labels: {}, value: Math.max(0, p99Ms) / 1000 }];
}

/** What one dispatch cycle's drops add to `fw_alert_sends_dropped_total`, zeros included. */
export function alertDropIncrements(
  dropped: Readonly<Record<AlertDropReason, number>>,
): CounterIncrement[] {
  return ALERT_DROP_REASONS.map((reason) => ({
    descriptor: ALERT_SENDS_DROPPED_TOTAL,
    labels: { reason },
    by: dropped[reason],
  }));
}

/**
 * What one evaluation cycle's deferrals add to `fw_alert_sends_deferred_total`, zeros
 * included — every reason, so both series exist from the first cycle.
 */
export function alertDeferralIncrements(
  deferred: Readonly<Record<AlertDeferralReason, number>>,
): CounterIncrement[] {
  return ALERT_DEFERRAL_REASONS.map((reason) => ({
    descriptor: ALERT_SENDS_DEFERRED_TOTAL,
    labels: { reason },
    by: deferred[reason],
  }));
}

/** The heartbeat success instant of `job` as a sample. */
export function jobSuccessSample(job: HeartbeatJobId, atMs: number): MetricSample {
  return { name: JOB_LAST_SUCCESS.name, labels: { job_id: job }, value: Math.floor(atMs / 1000) };
}

/**
 * What the nightly backup leaves behind for the textfile collector: every table's rows and
 * bytes, and the success instant under `job_id="nightly-backup"`. Only a real, successful
 * run calls this — a dry run or a failure writes nothing, so the timestamp ages.
 */
export function backupSamples(gauges: readonly TableGauge[], finishedAtMs: number): MetricSample[] {
  const samples: MetricSample[] = [jobSuccessSample('nightly-backup', finishedAtMs)];
  for (const gauge of gauges) {
    const labels = { relation: gauge.relation, set: gauge.set };
    samples.push(
      { name: BACKUP_TABLE_ROWS.name, labels, value: gauge.rows },
      { name: BACKUP_TABLE_BYTES.name, labels, value: gauge.bytes },
    );
  }
  return samples;
}
