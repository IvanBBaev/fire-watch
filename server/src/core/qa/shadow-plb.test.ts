import { describe, expect, it } from 'vitest';

import { QA_METRICS } from './qa-metrics-params.js';
import {
  budgetFor,
  shadowPlb,
  SHADOW_STAGES,
  type PipelineTrace,
  type PlbStage,
} from './shadow-plb.js';

const PARAMS = QA_METRICS.values;
const POLL_MS = 600_000;
const T0 = Date.UTC(2026, 7, 20, 6, 0, 0);
const MINUTE = 60_000;

function trace(overrides: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    traceId: 't1',
    availableAtMs: T0,
    ingestedAtMs: T0 + 30_000,
    eventUpdatedAtMs: T0 + 40_000,
    decidedAtMs: null,
    providerAckAtMs: null,
    providerChannel: null,
    broadcastAtMs: null,
    ...overrides,
  };
}

function stage(report: ReturnType<typeof shadowPlb>, name: PlbStage) {
  const found = report.stages.find((entry) => entry.stage === name);
  expect(found).toBeDefined();
  return found;
}

describe('stage spans', () => {
  it('measures each §8.1 stage from the trace timestamps', () => {
    const report = shadowPlb({ traces: [trace()], pollIntervalMs: POLL_MS });
    expect(stage(report, 'available_to_ingested')?.p95.value).toBe(30_000);
    expect(stage(report, 'ingested_to_event_updated')?.p95.value).toBe(10_000);
    expect(report.shadowTotal.p95.value).toBe(40_000);
  });

  it('treats a null timestamp as "did not happen", never as time zero', () => {
    const report = shadowPlb({ traces: [trace()], pollIntervalMs: POLL_MS });
    const decided = stage(report, 'event_updated_to_decided');
    expect(decided?.n).toBe(0);
    expect(decided?.p95.value).toBeNull();
    expect(decided?.withinBudget).toBeNull();
    expect(report.controllableTotal.n).toBe(0);
  });

  it('splits the ack budget by channel', () => {
    const report = shadowPlb({
      traces: [
        trace({
          traceId: 'push',
          decidedAtMs: T0 + 45_000,
          providerAckAtMs: T0 + 75_000,
          providerChannel: 'push',
        }),
        trace({
          traceId: 'email',
          decidedAtMs: T0 + 45_000,
          providerAckAtMs: T0 + 165_000,
          providerChannel: 'email',
        }),
      ],
      pollIntervalMs: POLL_MS,
    });
    expect(stage(report, 'decided_to_push_ack')?.n).toBe(1);
    expect(stage(report, 'decided_to_push_ack')?.p95.value).toBe(30_000);
    expect(stage(report, 'decided_to_email_ack')?.n).toBe(1);
    expect(stage(report, 'decided_to_email_ack')?.p95.value).toBe(120_000);
    expect(report.controllableTotal.n).toBe(2);
  });
});

describe('what CP1 measures and what it does not', () => {
  it('has observations for the shadow stages and none for the alert stack', () => {
    const report = shadowPlb({
      traces: [trace(), trace({ traceId: 't2' })],
      pollIntervalMs: POLL_MS,
    });
    for (const name of SHADOW_STAGES) {
      expect(stage(report, name)?.n).toBe(2);
    }
    for (const name of [
      'event_updated_to_decided',
      'decided_to_push_ack',
      'decided_to_email_ack',
      'event_updated_to_broadcast',
    ] as const) {
      expect(stage(report, name)?.n).toBe(0);
    }
  });

  it('never measures upstream source latency, which §8.1 forbids budgeting', () => {
    // There is no `acqTsMs` on the trace at all: the way to keep an unbudgetable number out
    // of a budget is to not accept it.
    expect(Object.keys(trace())).not.toContain('acqTsMs');
  });
});

describe('budgets', () => {
  it('states the ingest budget relative to the deployed poll interval', () => {
    expect(budgetFor('available_to_ingested', POLL_MS)).toBe(POLL_MS + 2 * MINUTE);
    expect(budgetFor('available_to_ingested', 5 * MINUTE)).toBe(7 * MINUTE);
  });

  it('uses the §8.1 fixed budgets for the stages that have one', () => {
    expect(budgetFor('ingested_to_event_updated', POLL_MS)).toBe(60_000);
    expect(budgetFor('event_updated_to_decided', POLL_MS)).toBe(10_000);
    expect(budgetFor('decided_to_push_ack', POLL_MS)).toBe(60_000);
    expect(budgetFor('decided_to_email_ack', POLL_MS)).toBe(5 * MINUTE);
    expect(budgetFor('event_updated_to_broadcast', POLL_MS)).toBe(2_000);
    expect(budgetFor('shadow_total', POLL_MS)).toBe(15 * MINUTE);
    expect(budgetFor('controllable_total', POLL_MS)).toBe(15 * MINUTE);
  });

  it('passes a p95 sitting exactly on the 15 min shadow budget', () => {
    const traces = Array.from({ length: 20 }, (_unused, index) =>
      trace({
        traceId: `t${String(index)}`,
        ingestedAtMs: T0 + 1_000,
        eventUpdatedAtMs: T0 + 15 * MINUTE,
      }),
    );
    const report = shadowPlb({ traces, pollIntervalMs: POLL_MS });
    expect(report.shadowTotal.p95.value).toBe(15 * MINUTE);
    expect(report.shadowTotal.withinBudget).toBe(true);
  });

  it('fails a p95 one millisecond over it', () => {
    const traces = Array.from({ length: 20 }, (_unused, index) =>
      trace({
        traceId: `t${String(index)}`,
        ingestedAtMs: T0 + 1_000,
        eventUpdatedAtMs: T0 + 15 * MINUTE + 1,
      }),
    );
    expect(shadowPlb({ traces, pollIntervalMs: POLL_MS }).shadowTotal.withinBudget).toBe(false);
  });
});

describe('the p95 over a small sample', () => {
  it('says the p95 is the maximum when the sample cannot support the quantile', () => {
    const traces = Array.from({ length: 5 }, (_unused, index) =>
      trace({ traceId: `t${String(index)}`, eventUpdatedAtMs: T0 + (index + 1) * MINUTE }),
    );
    const report = shadowPlb({ traces, pollIntervalMs: POLL_MS });
    expect(report.shadowTotal.n).toBe(5);
    expect(report.shadowTotal.p95.isMaximum).toBe(true);
    expect(report.shadowTotal.p95.value).toBe(5 * MINUTE);
  });

  it('tolerates one slow trace in twenty, which is what a p95 is for', () => {
    const traces = Array.from({ length: 20 }, (_unused, index) =>
      trace({
        traceId: `t${String(index)}`,
        ingestedAtMs: T0 + 1_000,
        eventUpdatedAtMs: T0 + (index === 19 ? 60 * MINUTE : MINUTE),
      }),
    );
    const report = shadowPlb({ traces, pollIntervalMs: POLL_MS });
    expect(report.shadowTotal.p95.isMaximum).toBe(false);
    expect(report.shadowTotal.p95.value).toBe(MINUTE);
    expect(report.shadowTotal.withinBudget).toBe(true);
  });

  it('reports p50 beside p95, as §8 asks for both', () => {
    const report = shadowPlb({ traces: [trace()], pollIntervalMs: POLL_MS });
    expect(report.shadowTotal.p50.p).toBe(PARAMS.quantile.p50);
    expect(report.shadowTotal.p95.p).toBe(PARAMS.quantile.p95);
    expect(report.shadowTotal.p50.method).toBe(PARAMS.quantile.method);
  });
});

describe('an empty window', () => {
  it('reports every stage unmeasured rather than perfect', () => {
    const report = shadowPlb({ traces: [], pollIntervalMs: POLL_MS });
    for (const entry of [...report.stages, report.shadowTotal, report.controllableTotal]) {
      expect(entry.n).toBe(0);
      expect(entry.p95.value).toBeNull();
      expect(entry.withinBudget).toBeNull();
      expect(entry.budgetMs).toBeGreaterThan(0);
    }
  });
});

describe('corrupt input', () => {
  it('refuses a stage that ran backwards rather than pulling the p95 down with it', () => {
    expect(() =>
      shadowPlb({ traces: [trace({ eventUpdatedAtMs: T0 + 10_000 })], pollIntervalMs: POLL_MS }),
    ).toThrow(/before it began/);
  });

  it('refuses an ack with no channel, because no budget would apply to it', () => {
    expect(() =>
      shadowPlb({
        traces: [trace({ decidedAtMs: T0 + 45_000, providerAckAtMs: T0 + 50_000 })],
        pollIntervalMs: POLL_MS,
      }),
    ).toThrow(/which channel/);
  });

  it('refuses a duplicate trace id', () => {
    expect(() => shadowPlb({ traces: [trace(), trace()], pollIntervalMs: POLL_MS })).toThrow(
      /duplicate/,
    );
  });

  it('refuses a poll interval that is not a positive number of ms', () => {
    expect(() => shadowPlb({ traces: [], pollIntervalMs: 0 })).toThrow(RangeError);
    expect(() => shadowPlb({ traces: [], pollIntervalMs: Number.NaN })).toThrow(RangeError);
  });

  it('refuses a non-finite timestamp', () => {
    expect(() =>
      shadowPlb({
        traces: [trace({ ingestedAtMs: Number.POSITIVE_INFINITY })],
        pollIntervalMs: POLL_MS,
      }),
    ).toThrow(/non-finite/);
  });
});

describe('the report as an evidence artifact', () => {
  it('carries the config identity and the poll interval the budget was read against', () => {
    const report = shadowPlb({ traces: [], pollIntervalMs: 300_000 });
    expect(report.configVersion).toBe(QA_METRICS.version);
    expect(report.configDigest).toBe(QA_METRICS.digest);
    expect(report.pollIntervalMs).toBe(300_000);
    expect(stage(report, 'available_to_ingested')?.budgetMs).toBe(300_000 + 2 * MINUTE);
  });
});
