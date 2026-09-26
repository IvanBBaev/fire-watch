import type { FreshnessReport } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import type { IngestCycleReport, SourceIngestResult } from '../ingest/ingest-cycle.js';
import { META_ALERT_KEYS, type MetaAlertKey } from '../monitoring/meta-alert-params.js';
import type { MonitorCycleReport, MonitorReadingReport } from '../monitoring/monitor-cycle.js';
import { ALERT_DEFERRAL_METRICS } from './alert-metrics.js';
import {
  alertDeferralIncrements,
  alertDropIncrements,
  backupSamples,
  eventLoopLagSamples,
  freshnessSamples,
  ingestIncrements,
  jobSuccessSample,
  META_ALERT_SERIES,
  metaAlertSamples,
  METRIC_CATALOG,
  SSE_REJECT_REASONS,
  transportSamples,
} from './metric-catalog.js';
import { formatExposition } from './prometheus-text.js';

describe('METRIC_CATALOG', () => {
  it('holds every descriptor declared elsewhere, once', () => {
    const names = METRIC_CATALOG.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of ALERT_DEFERRAL_METRICS) expect(names).toContain(d.name);
    expect(names).toContain('fw_backup_table_rows');
    expect(names).toContain('fw_backup_table_bytes');
  });

  it('prefixes every series with fw_', () => {
    for (const d of METRIC_CATALOG) expect(d.name).toMatch(/^fw_/);
  });

  it('maps every meta-alert key to a distinct catalogued gauge', () => {
    const names = META_ALERT_KEYS.map((key) => META_ALERT_SERIES[key].name);
    expect(new Set(names).size).toBe(META_ALERT_KEYS.length);
    for (const name of names) expect(METRIC_CATALOG.map((d) => d.name)).toContain(name);
    expect(META_ALERT_SERIES.outbox_queue_oldest_seconds.name).toBe(
      'fw_notification_queue_oldest_seconds',
    );
    expect(META_ALERT_SERIES.outbox_awaiting_approval_oldest_seconds.name).toBe(
      'fw_alert_approval_pending_seconds',
    );
  });
});

const REPORT: FreshnessReport = {
  generatedAt: '2026-09-25T10:00:00.000Z',
  status: 'critical',
  budgetVersion: 'freshness_budgets_v1',
  rows: [
    {
      row: 'snapshot-push',
      lastSuccessAt: '2026-09-25T09:30:00.500Z',
      lastDataAt: null,
      ageSeconds: 1800,
      warnSeconds: 300,
      criticalSeconds: 900,
      state: 'critical',
      consecutiveFailures: 4,
      pages: true,
      mutedUntil: null,
      muteReason: null,
    },
    {
      row: 'nightly-backup',
      lastSuccessAt: null,
      lastDataAt: null,
      ageSeconds: null,
      warnSeconds: 93_600,
      criticalSeconds: 180_000,
      state: 'unknown',
      consecutiveFailures: 0,
      pages: false,
      mutedUntil: null,
      muteReason: null,
    },
  ],
};

describe('freshnessSamples', () => {
  it('exports the verdict one-hot, with budgets and paging flag, and renders', () => {
    const samples = freshnessSamples(REPORT);
    const text = formatExposition(METRIC_CATALOG, samples);
    expect(text).toContain('fw_freshness_state{row="snapshot-push",state="critical"} 1');
    expect(text).toContain('fw_freshness_state{row="snapshot-push",state="ok"} 0');
    expect(text).toContain('fw_freshness_state{row="nightly-backup",state="unknown"} 1');
    expect(text).toContain('fw_freshness_budget_seconds{row="snapshot-push",band="critical"} 900');
    expect(text).toContain('fw_freshness_pages{row="snapshot-push"} 1');
    expect(text).toContain('fw_freshness_pages{row="nightly-backup"} 0');
    expect(text).toContain(
      'fw_freshness_last_success_timestamp_seconds{row="snapshot-push"} 1790328600',
    );
    expect(text).toContain('fw_freshness_age_seconds{row="snapshot-push"} 1800');
    expect(text).toContain('fw_freshness_consecutive_failures{row="snapshot-push"} 4');
    expect(text).toContain('fw_freshness_budget_version_info{version="freshness_budgets_v1"} 1');
  });

  it('omits the timestamp and the age of a row that never succeeded', () => {
    const text = formatExposition(METRIC_CATALOG, freshnessSamples(REPORT));
    expect(text).not.toContain('fw_freshness_age_seconds{row="nightly-backup"}');
    expect(text).not.toContain('fw_freshness_last_success_timestamp_seconds{row="nightly-backup"}');
  });
});

function reading(value: number | null): MonitorReadingReport {
  return { value, status: value === null ? 'no_data' : 'ok', page_above: null };
}

describe('metaAlertSamples', () => {
  const readings = Object.fromEntries(
    META_ALERT_KEYS.map((key) => [key, reading(key === 'canary_round_trip_seconds' ? null : 7)]),
  ) as Record<MetaAlertKey, MonitorReadingReport>;
  const report: MonitorCycleReport = {
    at: '2026-09-25T10:00:00.000Z',
    readings: { ...readings, outbox_queue_oldest_seconds: reading(0) },
    transitions: [],
    paging: ['outbox_queue_oldest_seconds'],
  };

  it('exports readings, keeps a zero, omits a null, and flags paging keys', () => {
    const text = formatExposition(METRIC_CATALOG, metaAlertSamples(report));
    expect(text).toContain('fw_notification_queue_oldest_seconds 0');
    expect(text).toContain('fw_notification_queue_depth 7');
    expect(text).toContain('fw_alert_approval_pending_seconds 7');
    expect(text).not.toContain('fw_canary_round_trip_seconds');
    expect(text).toContain('fw_meta_alert_paging{key="outbox_queue_oldest_seconds"} 1');
    expect(text).toContain('fw_meta_alert_paging{key="outbox_pending_rows"} 0');
  });
});

describe('ingestIncrements', () => {
  it('counts one attempt per source and adds its received and inserted counts', () => {
    const result = {
      source: 'firms:viirs:snpp',
      outcome: 'stored',
      received: 12,
      inserted: 5,
    } as unknown as SourceIngestResult;
    const report = {
      startedAt: 0,
      finishedAt: 1,
      sources: [result],
    } as unknown as IngestCycleReport;
    expect(ingestIncrements(report).map((i) => [i.descriptor.name, i.labels, i.by])).toEqual([
      ['fw_source_fetch_total', { source: 'firms:viirs:snpp', outcome: 'stored' }, 1],
      ['fw_source_records_fetched_total', { source: 'firms:viirs:snpp' }, 12],
      ['fw_source_records_inserted_total', { source: 'firms:viirs:snpp' }, 5],
    ]);
  });
});

describe('backupSamples', () => {
  it('writes the success instant and every table gauge', () => {
    const text = formatExposition(
      METRIC_CATALOG,
      backupSamples(
        [{ relation: 'public.detections', rows: 10, bytes: 8192, set: 'main' }],
        1_790_000_000_900,
      ),
    );
    expect(text).toContain(
      'fw_job_last_success_timestamp_seconds{job_id="nightly-backup"} 1790000000',
    );
    expect(text).toContain('fw_backup_table_rows{relation="public.detections",set="main"} 10');
    expect(text).toContain('fw_backup_table_bytes{relation="public.detections",set="main"} 8192');
  });

  it('floors a job success instant to whole seconds', () => {
    expect(jobSuccessSample('ingest-cycle', 1_999)).toEqual({
      name: 'fw_job_last_success_timestamp_seconds',
      labels: { job_id: 'ingest-cycle' },
      value: 1,
    });
  });
});

describe('transportSamples', () => {
  it('maps sse to tier 0 and poll to tier 1, with every reject reason including zeros', () => {
    const rejected = { not_offered: 0, not_ready: 0, capacity: 4, client_cap: 1 };
    const sse = transportSamples({ transport: 'sse', connections: 12, rejected });
    expect(sse[0]).toEqual({ name: 'fw_degradation_tier', labels: {}, value: 0 });
    expect(sse[1]).toEqual({ name: 'fw_sse_connections', labels: {}, value: 12 });
    expect(sse.slice(2).map((s) => s.labels['reason'])).toEqual([...SSE_REJECT_REASONS]);
    expect(sse).toContainEqual({
      name: 'fw_sse_rejected_total',
      labels: { reason: 'capacity' },
      value: 4,
    });
    const poll = transportSamples({ transport: 'poll', connections: 0, rejected });
    expect(poll[0]?.value).toBe(1);
    expect(() => formatExposition(METRIC_CATALOG, poll)).not.toThrow();
  });
});

describe('eventLoopLagSamples', () => {
  it('exports a reading in seconds and nothing without one', () => {
    expect(eventLoopLagSamples(250)).toEqual([
      { name: 'fw_event_loop_lag_p99_seconds', labels: {}, value: 0.25 },
    ]);
    expect(eventLoopLagSamples(null)).toEqual([]);
    expect(eventLoopLagSamples(Number.NaN)).toEqual([]);
    expect(eventLoopLagSamples(-1)[0]?.value).toBe(0);
  });
});

describe('alertDeferralIncrements', () => {
  it('adds each deferral reason, zeros included so the series exist from the first cycle', () => {
    const increments = alertDeferralIncrements({ over_budget_b: 2, manual_approval: 0 });
    expect(increments.map((i) => [i.descriptor.name, i.labels, i.by])).toEqual([
      ['fw_alert_sends_deferred_total', { reason: 'over_budget_b' }, 2],
      ['fw_alert_sends_deferred_total', { reason: 'manual_approval' }, 0],
    ]);
  });
});

describe('alertDropIncrements', () => {
  it('adds each drop reason, zeros included so the series exist from the first cycle', () => {
    const increments = alertDropIncrements({ expired_unapproved: 0, ttl_expired: 3 });
    expect(increments.map((i) => [i.descriptor.name, i.labels, i.by])).toEqual([
      ['fw_alert_sends_dropped_total', { reason: 'expired_unapproved' }, 0],
      ['fw_alert_sends_dropped_total', { reason: 'ttl_expired' }, 3],
    ]);
  });
});
