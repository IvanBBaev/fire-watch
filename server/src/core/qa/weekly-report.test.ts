import { afterEach, describe, expect, it } from 'vitest';

import { ALERT_GATING } from '../config/alert-gating.js';
import type { QaAlertRow } from '../ports/qa-report-store.js';
import { isoWeekWindow, utcDayRangeWindow } from './iso-week.js';
import { QA_METRICS } from './qa-metrics-params.js';
import type { PipelineTrace } from './shadow-plb.js';
import {
  buildWeeklyReport,
  ladderStepFromSubkey,
  renderReportJson,
  renderReportMarkdown,
  REPORT_KIND,
  type WeeklyReportInput,
} from './weekly-report.js';
import { QA_WEEKLY_REPORT } from './weekly-report-params.js';

const WEEK = isoWeekWindow('2026-W38');
const T0 = WEEK.fromMs;
const HOUR = 3_600_000;
const SUPPRESSION = ALERT_GATING.values.suppressionWindowMs;

function trace(id: string, offsetMs: number, ingestMs: number, attachMs: number | null) {
  const availableAtMs = T0 + offsetMs;
  const t: PipelineTrace = {
    traceId: id,
    availableAtMs,
    ingestedAtMs: availableAtMs + ingestMs,
    eventUpdatedAtMs: attachMs === null ? null : availableAtMs + ingestMs + attachMs,
    decidedAtMs: null,
    providerAckAtMs: null,
    providerChannel: null,
    broadcastAtMs: null,
  };
  return t;
}

function alert(id: string, decidedAtMs: number, overrides: Partial<QaAlertRow> = {}): QaAlertRow {
  return {
    alertId: id,
    zoneId: 'zone-a',
    eventKey: 'evt-1',
    alertType: 'new_fire',
    alertSubkey: 'once',
    decidedAtMs,
    ...overrides,
  };
}

function input(overrides: Partial<WeeklyReportInput> = {}): WeeklyReportInput {
  return {
    window: WEEK,
    generatedAtMs: WEEK.toMs + 5 * 60_000,
    pollIntervalMs: 600_000,
    plbTraces: [
      trace('d1', 1 * HOUR, 60_000, 30_000),
      trace('d2', 2 * HOUR, 120_000, null),
      trace('d3', 30 * HOUR, 90_000, 45_000),
    ],
    darAlerts: [
      // A lead-in alert that the first in-window alert repeats across Monday 00:00.
      alert('10', T0 - HOUR),
      alert('11', T0 + HOUR),
      alert('12', T0 + 2 * HOUR, { zoneId: 'zone-b' }),
      alert('13', T0 + 3 * HOUR, {
        alertType: 'escalation',
        alertSubkey: 'step-1',
        zoneId: 'zone-b',
      }),
      alert('14', T0 + 4 * HOUR, {
        alertType: 'escalation',
        alertSubkey: 'step-2',
        zoneId: 'zone-b',
      }),
    ],
    ...overrides,
  };
}

describe('buildWeeklyReport', () => {
  it('stamps both configs, the window and the unratified week boundary', () => {
    const report = buildWeeklyReport(input());
    expect(report.kind).toBe(REPORT_KIND);
    expect(report.metricsVersion).toBe(QA_METRICS.version);
    expect(report.metricsDigest).toBe(QA_METRICS.digest);
    expect(report.reportVersion).toBe(QA_WEEKLY_REPORT.version);
    expect(report.reportDigest).toBe(QA_WEEKLY_REPORT.digest);
    expect(report.window).toMatchObject({
      isoWeek: '2026-W38',
      from: '2026-09-14T00:00:00Z',
      to: '2026-09-21T00:00:00Z',
      calendar: 'iso8601',
      timeZone: 'UTC',
      boundaryRatified: false,
    });
    expect(report.complete).toBe(true);
    expect(report.openDecisions.map((d) => d.id)).toContain('week_boundary');
  });

  it('marks a report built before the window closed as partial', () => {
    expect(buildWeeklyReport(input({ generatedAtMs: WEEK.toMs - 1 })).complete).toBe(false);
  });

  it('reports PCR, FER and FLR as unavailable with what each needs, not as zero', () => {
    const { metrics } = buildWeeklyReport(input());
    for (const metric of [metrics.shadowPcr, metrics.fer, metrics.flr]) {
      expect(metric.status).toBe('unavailable');
      expect(metric.reason.length).toBeGreaterThan(0);
      expect(metric.needs.length).toBeGreaterThan(0);
    }
  });

  it('measures PLB over the traced stages, the unattached detection counted only once', () => {
    const { shadowPlb } = buildWeeklyReport(input()).metrics;
    expect(shadowPlb.traces).toBe(3);
    const stages = new Map(shadowPlb.report.stages.map((s) => [s.stage, s]));
    expect(stages.get('available_to_ingested')?.n).toBe(3);
    expect(stages.get('ingested_to_event_updated')?.n).toBe(2);
    expect(shadowPlb.report.shadowTotal.n).toBe(2);
    expect(shadowPlb.eventUpdatedProxy).toBe('first_live_attachment');
  });

  it('counts DAR over the window only, while seeing repeats across its start', () => {
    const { dar } = buildWeeklyReport(input()).metrics;
    // 11 repeats lead-in 10; 14 is a higher rung than 13, so it is not a repeat.
    expect(dar.duplicates).toEqual([{ alertId: '11', repeatsAlertId: '10', gapMs: 2 * HOUR }]);
    expect(dar.rate).toEqual({ numerator: 1, denominator: 4, rate: 0.25 });
    expect(dar.leadInAlerts).toBe(1);
    expect(dar.leadInFrom).toBe('2026-09-13T18:00:00Z');
    expect(dar.meetsShadowTarget).toBe(false);
    expect(dar.meetsSteadyTarget).toBe(false);
  });

  it('leaves DAR unmeasured, not passing, on a week without alerts', () => {
    const { dar } = buildWeeklyReport(input({ darAlerts: [] })).metrics;
    expect(dar.rate.rate).toBeNull();
    expect(dar.meetsShadowTarget).toBeNull();
    expect(dar.meetsSteadyTarget).toBeNull();
  });

  it('refuses rows outside what the reader was asked for', () => {
    expect(() =>
      buildWeeklyReport(input({ plbTraces: [trace('late', 7 * 24 * HOUR, 1_000, null)] })),
    ).toThrow(/outside the report window/);
    expect(() =>
      buildWeeklyReport(input({ darAlerts: [alert('1', T0 - SUPPRESSION - 1)] })),
    ).toThrow(/outside the window and its lead-in/);
  });

  it('refuses an escalation whose subkey is not a ladder step', () => {
    expect(() =>
      buildWeeklyReport(
        input({ darAlerts: [alert('1', T0, { alertType: 'escalation', alertSubkey: 'x' })] }),
      ),
    ).toThrow(/not step-N/);
  });

  it('labels an ad-hoc range as unlabelled', () => {
    const window = utcDayRangeWindow('2026-09-15', '2026-09-16');
    const report = buildWeeklyReport(
      input({ window, plbTraces: [], darAlerts: [], generatedAtMs: window.toMs }),
    );
    expect(report.window.isoWeek).toBeNull();
    expect(renderReportMarkdown(report)).toContain(
      '# Fire Watch weekly QA report: 2026-09-15T00:00:00Z – 2026-09-17T00:00:00Z',
    );
  });
});

describe('ladderStepFromSubkey', () => {
  it('reads step-N and nothing else', () => {
    expect(ladderStepFromSubkey('step-1')).toBe(1);
    expect(ladderStepFromSubkey('step-12')).toBe(12);
    for (const bad of ['step-0', 'step-01', 'step-', 'step-1a', '1']) {
      expect(() => ladderStepFromSubkey(bad)).toThrow(RangeError);
    }
  });
});

describe('rendering', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => {
    if (originalTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTz;
  });

  it('is byte-identical under any host time zone', () => {
    const renderBoth = () => {
      const report = buildWeeklyReport(input());
      return [renderReportJson(report), renderReportMarkdown(report)];
    };
    process.env['TZ'] = 'UTC';
    const reference = renderBoth();
    for (const zone of ['Pacific/Kiritimati', 'Europe/Sofia', 'America/St_Johns']) {
      process.env['TZ'] = zone;
      expect(renderBoth()).toEqual(reference);
    }
  });

  it('renders JSON that parses back to the report', () => {
    const report = buildWeeklyReport(input());
    expect(JSON.parse(renderReportJson(report))).toEqual(JSON.parse(JSON.stringify(report)));
    expect(renderReportJson(report)).not.toContain('\n');
  });

  it('renders the summary a person reads', () => {
    const markdown = renderReportMarkdown(buildWeeklyReport(input()));
    expect(markdown).toContain('# Fire Watch weekly QA report: 2026-W38');
    expect(markdown).toContain('boundary NOT ratified');
    expect(markdown).toContain(
      '| DAR | measured | 25.00 % (1/4) | 4 alerts | <= 5.00 % shadow, <= 1.00 % steady | ' +
        'shadow no, steady no |',
    );
    expect(markdown).toContain('| Shadow-PCR | unavailable |');
    expect(markdown).toContain('| 11 | 10 | 2.0 h |');
    expect(markdown).toContain('- `lifecycle_transition_log`:');
  });

  it('keeps the golden bytes', () => {
    const report = buildWeeklyReport(input());
    expect(fnv1a(renderReportJson(report))).toMatchInlineSnapshot(`"9e59a236"`);
    expect(fnv1a(renderReportMarkdown(report))).toMatchInlineSnapshot(`"1188a18e"`);
  });
});

/** FNV-1a over UTF-16 code units, hex — a short, stable golden for a long rendering. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
