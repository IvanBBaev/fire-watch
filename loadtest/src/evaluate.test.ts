import { describe, expect, it } from 'vitest';

import { PLANNING_BASELINE, type Baseline } from './baseline.js';
import { computeMetrics, evaluate, overallOf, type Verdict } from './evaluate.js';
import { MetricsRecorder } from './metrics.js';
import { buildScenario, plannedArrivals, REQUEST_STREAMS } from './scenario.js';
import { L3_THRESHOLDS, compare, resolveBound } from './thresholds.js';

const MEASURED: Baseline = { ...PLANNING_BASELINE, label: 'measured', source: 'measured' };
const scenario = buildScenario({
  baseline: MEASURED,
  durationsMs: { ramp: 10_000, steady: 100_000, originKill: 10_000 },
});

/** A run that meets every L-3 row; each test spoils one thing. */
function healthyRun(spoil: (r: MetricsRecorder) => void = () => undefined): MetricsRecorder {
  const r = new MetricsRecorder();
  const planned = { snapshot: 0, clientConfig: 0, t2: 0 };
  for (const stream of REQUEST_STREAMS) planned[stream] = plannedArrivals(scenario, stream);
  r.setPlanned(planned);
  r.setPhaseDuration('ramp', 10_000);
  r.setPhaseDuration('steady', 100_000);
  r.setPhaseDuration('origin-kill', 10_000);
  const issue = (
    phase: 'ramp' | 'steady' | 'origin-kill',
    stream: 'snapshot' | 'clientConfig' | 't2',
    n: number,
  ): void => {
    for (let i = 0; i < n; i += 1) r.issued(phase, stream);
  };
  issue('ramp', 'snapshot', Math.ceil(planned.snapshot * (5 / 105)));
  issue('steady', 'snapshot', Math.ceil(planned.snapshot * (100 / 105)));
  issue('steady', 'clientConfig', Math.ceil(planned.clientConfig));
  issue('origin-kill', 't2', Math.ceil(planned.t2));
  // 1,000 steady answers: 980 hits, 20 misses in 100 s → 0.98 and 0.2 req/s.
  for (let i = 0; i < 1_000; i += 1) {
    r.response('steady', 'snapshot', {
      status: 200,
      latencyMs: 40,
      cacheStatus: i < 980 ? 'hit' : 'MISS',
    });
  }
  for (let i = 0; i < 100; i += 1)
    r.response('origin-kill', 't2', { status: 200, latencyMs: 30, cacheStatus: null });
  r.t2ObjectAge(120);
  // SSE: 5,000 admitted, demotion, every stream closed cleanly, the rest refused properly.
  for (let i = 0; i < 5_000; i += 1) {
    r.sseAttempt('steady');
    r.sseOpened('steady');
  }
  r.sseDegrade('steady', 'capacity', 50_000);
  for (let i = 0; i < 5_000; i += 1) r.sseClosed('steady', true);
  for (let i = 0; i < 100; i += 1) {
    r.sseAttempt('steady');
    r.sseRefused('steady', 503, true);
  }
  r.clientConfigTransport('sse', 10_000);
  r.clientConfigTransport('poll', 62_000);
  spoil(r);
  return r;
}

const stateOf = (verdicts: readonly Verdict[], id: string): string | undefined =>
  verdicts.find((v) => v.id === id)?.state;

describe('evaluate', () => {
  it('passes a run that meets every L-3 row', () => {
    const result = evaluate(scenario, healthyRun().toJSON());
    expect(result.verdicts.filter((v) => v.state !== 'pass')).toEqual([]);
    expect(result.overall).toBe('pass');
    expect(result.rehearsal).toBe(false);
    expect(result.metrics.edgeHitRatio).toBeCloseTo(0.98, 6);
    expect(result.metrics.originRps).toBeCloseTo(0.2, 6);
    expect(result.metrics.clientConfigFlipSeconds).toBe(12);
    expect(result.metrics.ssePeakOpen).toBe(5_000);
  });

  it('fails on a 5xx to a map client', () => {
    const run = healthyRun((r) =>
      r.response('steady', 'clientConfig', { status: 502, latencyMs: 1, cacheStatus: null }),
    );
    const result = evaluate(scenario, run.toJSON());
    expect(stateOf(result.verdicts, 'map-client-5xx')).toBe('fail');
    expect(result.overall).toBe('fail');
  });

  it('fails on a stream that ends without a degrade frame, or a refusal without Retry-After', () => {
    const unclean = healthyRun((r) => {
      r.sseOpened('steady');
      r.sseClosed('steady', false);
      r.sseRefused('steady', 503, false);
      r.sseRefused('steady', 500, true);
    });
    const result = evaluate(scenario, unclean.toJSON());
    expect(stateOf(result.verdicts, 'sse-unclean-closes')).toBe('fail');
    expect(result.metrics.sseUnexpectedStatus).toBe(2);
    expect(stateOf(result.verdicts, 'sse-unexpected-status')).toBe('fail');
    expect(result.overall).toBe('fail');
  });

  it('fails when more streams were open at once than the cap', () => {
    const over = healthyRun((r) => {
      for (let i = 0; i < 5_001; i += 1) r.sseOpened('steady');
    });
    expect(stateOf(evaluate(scenario, over.toJSON()).verdicts, 'sse-peak-open')).toBe('fail');
  });

  it('fails when the edge misses too often', () => {
    const run = healthyRun((r) => {
      for (let i = 0; i < 1_000; i += 1)
        r.response('steady', 'snapshot', { status: 200, latencyMs: 40, cacheStatus: 'MISS' });
    });
    const result = evaluate(scenario, run.toJSON());
    expect(stateOf(result.verdicts, 'edge-hit-ratio')).toBe('fail');
    expect(stateOf(result.verdicts, 'origin-rps')).toBe('fail');
  });

  it('is incomplete, never pass, without the edge header', () => {
    const r = new MetricsRecorder();
    const planned = { snapshot: 0, clientConfig: 0, t2: 0 };
    r.setPlanned(planned);
    r.setPhaseDuration('steady', 1_000);
    r.response('steady', 'snapshot', { status: 200, latencyMs: 5, cacheStatus: null });
    const notes: string[] = [];
    const table = computeMetrics(scenario, r.toJSON(), notes);
    expect(table.edgeHitRatio).toBeNull();
    expect(notes.join()).toMatch(/unclassifiable/);
    const result = evaluate(scenario, r.toJSON());
    expect(stateOf(result.verdicts, 'edge-hit-ratio')).toBe('not_measured');
    expect(result.overall).toBe('incomplete');
  });

  it('is invalid when the generator fell short, whatever else it saw', () => {
    const run = healthyRun((r) => {
      r.setPlanned({ snapshot: 1e9, clientConfig: 0, t2: 0 });
      r.response('steady', 'clientConfig', { status: 500, latencyMs: 1, cacheStatus: null });
    });
    expect(evaluate(scenario, run.toJSON()).overall).toBe('invalid');
  });

  it('judges T2 on answers and object age, counting network errors as failures', () => {
    const old = healthyRun((r) => {
      r.t2ObjectAge(301);
      r.networkError('origin-kill', 't2');
    });
    const result = evaluate(scenario, old.toJSON());
    expect(stateOf(result.verdicts, 't2-max-object-age')).toBe('fail');
    expect(stateOf(result.verdicts, 't2-success-ratio')).toBe('fail');
  });

  it('marks cap and origin-kill rows not applicable when the scenario cannot exercise them', () => {
    const small = buildScenario({
      baseline: MEASURED,
      multiplier: 1,
      durationsMs: { ramp: 1_000, steady: 1_000, originKill: 0 },
    });
    const result = evaluate(small, new MetricsRecorder().toJSON());
    for (const id of [
      'sse-demotion-observed',
      'client-config-flip',
      't2-success-ratio',
      't2-max-object-age',
    ]) {
      expect(stateOf(result.verdicts, id)).toBe('not_applicable');
    }
    expect(result.rehearsal).toBe(true);
    expect(result.notes.join()).toMatch(/rehearsal/);
  });

  it('flags the planning baseline as a rehearsal', () => {
    const result = evaluate(buildScenario(), new MetricsRecorder().toJSON());
    expect(result.rehearsal).toBe(true);
    expect(result.notes.join()).toMatch(/planning figure/);
  });
});

describe('overallOf', () => {
  const row = (kind: 'gate' | 'validity', state: Verdict['state']): Verdict => ({
    id: 'x',
    kind,
    metric: 'originRps',
    observed: 0,
    op: 'lte',
    bound: 0,
    unit: '',
    state,
    source: '',
  });
  it('ranks invalid > fail > incomplete > pass', () => {
    expect(overallOf([row('gate', 'fail'), row('validity', 'fail')])).toBe('invalid');
    expect(overallOf([row('gate', 'fail'), row('gate', 'not_measured')])).toBe('fail');
    expect(overallOf([row('gate', 'pass'), row('gate', 'not_measured')])).toBe('incomplete');
    expect(overallOf([row('gate', 'pass'), row('gate', 'not_applicable')])).toBe('pass');
  });
});

describe('L3_THRESHOLDS', () => {
  it('encodes the gate figures and cites a source on every row', () => {
    const byId = new Map(L3_THRESHOLDS.map((t) => [t.id, t]));
    expect(new Set(L3_THRESHOLDS.map((t) => t.id)).size).toBe(L3_THRESHOLDS.length);
    expect(byId.get('edge-hit-ratio')?.bound).toBe(0.95);
    expect(byId.get('origin-rps')?.bound).toBe(5);
    expect(byId.get('snapshot-p95')?.bound).toBe(300);
    const context = { sseCap: 5_000, t2ObjectAgeBudgetSeconds: 300 };
    const peak = byId.get('sse-peak-open');
    if (peak === undefined) throw new Error('row missing');
    expect(resolveBound(peak, context)).toBe(5_000);
    expect(L3_THRESHOLDS.every((t) => t.source.length > 0)).toBe(true);
    expect(compare('eq', 1, 1)).toBe(true);
  });
});
