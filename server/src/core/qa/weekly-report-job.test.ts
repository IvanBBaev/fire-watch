import { describe, expect, it } from 'vitest';

import { ALERT_GATING } from '../config/alert-gating.js';
import { VirtualClock } from '../ports/clock.js';
import type {
  QaAlertRow,
  QaReportInputReader,
  QaReportStore,
  QaWindowQuery,
  StoredWeeklyReport,
} from '../ports/qa-report-store.js';
import { isoWeekWindow, utcDayRangeWindow } from './iso-week.js';
import { QA_METRICS } from './qa-metrics-params.js';
import type { PipelineTrace } from './shadow-plb.js';
import { runWeeklyQaReport, summarizeOutcome } from './weekly-report-job.js';
import { QA_WEEKLY_REPORT } from './weekly-report-params.js';

const W38 = isoWeekWindow('2026-W38');
const NOW = Date.parse('2026-09-23T10:00:00Z'); // Wednesday of W39

interface Fakes {
  readonly reader: QaReportInputReader;
  readonly store: QaReportStore;
  readonly plbQueries: QaWindowQuery[];
  readonly darQueries: QaWindowQuery[];
  readonly saved: StoredWeeklyReport[];
  readonly hasQueries: unknown[];
}

function fakes(
  options: {
    stored?: boolean;
    traces?: readonly PipelineTrace[];
    alerts?: readonly QaAlertRow[];
  } = {},
): Fakes {
  const plbQueries: QaWindowQuery[] = [];
  const darQueries: QaWindowQuery[] = [];
  const saved: StoredWeeklyReport[] = [];
  const hasQueries: unknown[] = [];
  return {
    plbQueries,
    darQueries,
    saved,
    hasQueries,
    reader: {
      loadPlbTraces(window) {
        plbQueries.push(window);
        return Promise.resolve(options.traces ?? []);
      },
      loadDarAlerts(window) {
        darQueries.push(window);
        return Promise.resolve(options.alerts ?? []);
      },
    },
    store: {
      has(query) {
        hasQueries.push(query);
        return Promise.resolve(options.stored ?? false);
      },
      save(report) {
        saved.push(report);
        return Promise.resolve();
      },
    },
  };
}

const deps = (f: Fakes, now = NOW) => ({
  reader: f.reader,
  store: f.store,
  clock: new VirtualClock(now),
  pollIntervalMs: 600_000,
});

describe('runWeeklyQaReport, scheduled', () => {
  it('builds and stores the last closed week', async () => {
    const f = fakes();
    const outcome = await runWeeklyQaReport(deps(f));
    expect(f.hasQueries).toEqual([
      {
        isoWeek: '2026-W38',
        metricsVersion: QA_METRICS.version,
        reportVersion: QA_WEEKLY_REPORT.version,
      },
    ]);
    expect(outcome.outcome).toBe('built');
    expect(f.saved).toHaveLength(1);
    const [row] = f.saved;
    expect(row).toMatchObject({
      isoWeek: '2026-W38',
      fromMs: W38.fromMs,
      toMs: W38.toMs,
      metricsVersion: QA_METRICS.version,
      metricsDigest: QA_METRICS.digest,
      reportVersion: QA_WEEKLY_REPORT.version,
      reportDigest: QA_WEEKLY_REPORT.digest,
      generatedAtMs: NOW,
    });
    if (outcome.outcome === 'built') {
      expect(row?.reportJson).toBe(outcome.json);
      expect(row?.reportMarkdown).toBe(outcome.markdown);
    }
  });

  it('reads PLB over the week and DAR with one suppression window of lead-in', async () => {
    const f = fakes();
    await runWeeklyQaReport(deps(f));
    expect(f.plbQueries).toEqual([{ fromMs: W38.fromMs, toMs: W38.toMs }]);
    expect(f.darQueries).toEqual([
      { fromMs: W38.fromMs - ALERT_GATING.values.suppressionWindowMs, toMs: W38.toMs },
    ]);
  });

  it('skips a week already stored under both versions, reading nothing', async () => {
    const f = fakes({ stored: true });
    const outcome = await runWeeklyQaReport(deps(f));
    expect(outcome).toEqual({ outcome: 'skipped', isoWeek: '2026-W38', reason: 'already_stored' });
    expect(f.plbQueries).toHaveLength(0);
    expect(f.saved).toHaveLength(0);
  });
});

describe('runWeeklyQaReport, explicit window', () => {
  it('rebuilds a stored week without asking whether it is stored', async () => {
    const f = fakes({ stored: true });
    const outcome = await runWeeklyQaReport(deps(f), { window: W38 });
    expect(f.hasQueries).toHaveLength(0);
    expect(outcome.outcome === 'built' && outcome.persisted).toBe(true);
    expect(f.saved).toHaveLength(1);
  });

  it('never stores an ad-hoc range', async () => {
    const f = fakes();
    const outcome = await runWeeklyQaReport(deps(f), {
      window: utcDayRangeWindow('2026-09-01', '2026-09-10'),
    });
    expect(outcome.outcome === 'built' && outcome.persisted).toBe(false);
    expect(f.saved).toHaveLength(0);
  });

  it('never stores a week that is still open', async () => {
    const f = fakes();
    const outcome = await runWeeklyQaReport(deps(f), { window: isoWeekWindow('2026-W39') });
    expect(outcome.outcome === 'built' && outcome.report.complete).toBe(false);
    expect(outcome.outcome === 'built' && outcome.persisted).toBe(false);
    expect(f.saved).toHaveLength(0);
  });

  it('lets a reader failure through, storing nothing', async () => {
    const f = fakes();
    const failing = {
      ...deps(f),
      reader: { ...f.reader, loadDarAlerts: () => Promise.reject(new Error('boom')) },
    };
    await expect(runWeeklyQaReport(failing, { window: W38 })).rejects.toThrow('boom');
    expect(f.saved).toHaveLength(0);
  });
});

describe('summarizeOutcome', () => {
  it('prints counts and verdicts, never the report body', async () => {
    const f = fakes();
    const summary = summarizeOutcome(await runWeeklyQaReport(deps(f)));
    expect(summary).toEqual({
      outcome: 'built',
      isoWeek: '2026-W38',
      persisted: true,
      complete: true,
      metricsVersion: QA_METRICS.version,
      reportVersion: QA_WEEKLY_REPORT.version,
      plbTraces: 0,
      plbShadowP95Ms: null,
      plbWithinBudget: null,
      darNumerator: 0,
      darDenominator: 0,
      darMeetsShadowTarget: null,
      unavailable: ['shadowPcr', 'fer', 'flr'],
    });
  });
});
