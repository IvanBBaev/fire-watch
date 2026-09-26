import { describe, expect, it } from 'vitest';

import { Histogram } from './histogram.js';
import { MetricsRecorder, mergeMetrics } from './metrics.js';

describe('MetricsRecorder', () => {
  it('counts statuses and raw cache-status values, normalised', () => {
    const r = new MetricsRecorder();
    r.issued('steady', 'snapshot');
    r.response('steady', 'snapshot', { status: 304, latencyMs: 12, cacheStatus: ' hit ' });
    r.response('steady', 'snapshot', { status: 200, latencyMs: 80, cacheStatus: null });
    const stats = r.toJSON().phases.steady.streams.snapshot;
    expect(stats).toMatchObject({ issued: 1, completed: 2, status: { '304': 1, '200': 1 } });
    expect(stats.cacheStatus).toEqual({ HIT: 1, '(none)': 1 });
    expect(Histogram.from(stats.latency).count).toBe(2);
  });

  it('tracks open streams globally and attributes the peak to the phase', () => {
    const r = new MetricsRecorder();
    r.sseOpened('ramp');
    r.sseOpened('ramp');
    r.sseOpened('steady');
    r.sseClosed('steady', true);
    r.sseAbandoned();
    expect(r.openStreams()).toBe(1);
    const data = r.toJSON();
    expect(data.phases.ramp.sse.peakOpen).toBe(2);
    expect(data.phases.steady.sse.peakOpen).toBe(3);
    expect(data.phases.steady.sse.cleanCloses).toBe(1);
  });

  it('measures the client-config flip from the first degrade frame only', () => {
    const r = new MetricsRecorder();
    r.clientConfigTransport('poll', 100); // before any demotion: not a flip
    r.sseDegrade('steady', 'capacity', 1_000);
    r.sseDegrade('steady', 'capacity', 5_000);
    r.clientConfigTransport('poll', 4_000);
    r.clientConfigTransport('poll', 9_000);
    expect(r.toJSON().clientConfig).toEqual({ observations: { poll: 3 }, flipMs: 3_000 });
  });

  it('keeps the oldest T2 object and counts undated ones', () => {
    const r = new MetricsRecorder();
    r.t2ObjectAge(10);
    r.t2ObjectAge(90);
    r.t2ObjectAge(null);
    expect(r.toJSON().t2).toEqual({ maxObjectAgeSeconds: 90, undated: 1 });
  });

  it('requires Retry-After only on 503/429 refusals', () => {
    const r = new MetricsRecorder();
    r.sseRefused('steady', 503, false);
    r.sseRefused('steady', 429, true);
    r.sseRefused('steady', 404, false);
    expect(r.toJSON().phases.steady.sse).toMatchObject({
      refused: { '503': 1, '429': 1, '404': 1 },
      refusedWithoutRetryAfter: 1,
    });
  });
});

describe('mergeMetrics', () => {
  it('adds counts, keeps the worst case, and merges latency distributions', () => {
    const a = new MetricsRecorder();
    const b = new MetricsRecorder();
    a.setPlanned({ snapshot: 10, clientConfig: 1, t2: 0 });
    b.setPlanned({ snapshot: 10, clientConfig: 1, t2: 0 });
    a.setPhaseDuration('steady', 1_000);
    b.setPhaseDuration('steady', 1_200);
    a.response('steady', 'snapshot', { status: 200, latencyMs: 10, cacheStatus: 'HIT' });
    b.response('steady', 'snapshot', { status: 200, latencyMs: 500, cacheStatus: 'HIT' });
    a.sseOpened('steady');
    b.sseOpened('steady');
    a.t2ObjectAge(10);
    b.t2ObjectAge(null);
    const merged = mergeMetrics([a.toJSON(), b.toJSON()]);
    expect(merged.planned.snapshot).toBe(20);
    expect(merged.phases.steady.durationMs).toBe(1_200);
    expect(merged.phases.steady.streams.snapshot.cacheStatus).toEqual({ HIT: 2 });
    expect(merged.phases.steady.sse.peakOpen).toBe(2);
    expect(merged.t2).toEqual({ maxObjectAgeSeconds: 10, undated: 1 });
    expect(
      Histogram.from(merged.phases.steady.streams.snapshot.latency).quantile(1),
    ).toBeGreaterThan(400);
  });
});
