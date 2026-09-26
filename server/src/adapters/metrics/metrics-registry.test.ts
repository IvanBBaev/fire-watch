import { describe, expect, it } from 'vitest';

import type { MetricDescriptor } from '../../core/observability/prometheus-text.js';
import { createMetricsRegistry } from './metrics-registry.js';

const GAUGE: MetricDescriptor = {
  name: 'fw_test_gauge',
  kind: 'gauge',
  help: 'A gauge.',
  labels: ['row'],
};
const COUNTER: MetricDescriptor = {
  name: 'fw_test_total',
  kind: 'counter',
  help: 'A counter.',
  labels: ['outcome'],
};
const CATALOG = [GAUGE, COUNTER];

describe('createMetricsRegistry', () => {
  it('renders nothing before anything is recorded', async () => {
    expect(await createMetricsRegistry(CATALOG).render()).toBe('');
  });

  it('keeps the latest gauge value per series', async () => {
    const registry = createMetricsRegistry(CATALOG);
    registry.setGauge(GAUGE, { row: 'a' }, 1);
    registry.setGauge(GAUGE, { row: 'a' }, 2);
    registry.setGauge(GAUGE, { row: 'b' }, 3);
    const text = await registry.render();
    expect(text).toContain('fw_test_gauge{row="a"} 2\n');
    expect(text).toContain('fw_test_gauge{row="b"} 3\n');
  });

  it('accumulates counters per series and refuses to move one backwards', async () => {
    const registry = createMetricsRegistry(CATALOG);
    registry.incCounter(COUNTER, { outcome: 'ok' });
    registry.incCounter(COUNTER, { outcome: 'ok' }, 4);
    registry.incCounter(COUNTER, { outcome: 'error' }, 0);
    expect(() => {
      registry.incCounter(COUNTER, { outcome: 'ok' }, -1);
    }).toThrow(RangeError);
    expect(() => {
      registry.incCounter(COUNTER, { outcome: 'ok' }, Number.NaN);
    }).toThrow(RangeError);
    const text = await registry.render();
    expect(text).toContain('fw_test_total{outcome="ok"} 5\n');
    expect(text).toContain('fw_test_total{outcome="error"} 0\n');
  });

  it('refuses a descriptor that is not the catalogued one, or of the wrong kind', () => {
    const registry = createMetricsRegistry(CATALOG);
    expect(() => {
      registry.setGauge({ ...GAUGE }, { row: 'a' }, 1);
    }).toThrow(/not in this registry's catalogue/);
    expect(() => {
      registry.setGauge(COUNTER, { outcome: 'ok' }, 1);
    }).toThrow(/not a gauge/);
    expect(() => {
      registry.incCounter(GAUGE, { row: 'a' });
    }).toThrow(/not a counter/);
  });

  it('replaces a whole family, so a series that went away disappears', async () => {
    const registry = createMetricsRegistry(CATALOG);
    registry.replaceFamily(GAUGE, [
      { name: GAUGE.name, labels: { row: 'a' }, value: 1 },
      { name: GAUGE.name, labels: { row: 'b' }, value: 2 },
    ]);
    registry.replaceFamily(GAUGE, [{ name: GAUGE.name, labels: { row: 'b' }, value: 5 }]);
    const text = await registry.render();
    expect(text).not.toContain('row="a"');
    expect(text).toContain('fw_test_gauge{row="b"} 5\n');
    expect(() => {
      registry.replaceFamily(GAUGE, [{ name: COUNTER.name, labels: {}, value: 1 }]);
    }).toThrow(RangeError);
  });

  it('adds collector samples at render time and isolates a failing collector', async () => {
    const registry = createMetricsRegistry(CATALOG);
    let calls = 0;
    registry.addCollector(() => {
      calls += 1;
      return [{ name: GAUGE.name, labels: { row: 'live' }, value: calls }];
    });
    registry.addCollector(() => Promise.reject(new Error('down')));
    registry.addCollector(() => {
      throw new Error('broken');
    });
    registry.incCounter(COUNTER, { outcome: 'ok' });
    expect(await registry.render()).toContain('fw_test_gauge{row="live"} 1\n');
    const text = await registry.render();
    expect(text).toContain('fw_test_gauge{row="live"} 2\n');
    expect(text).toContain('fw_test_total{outcome="ok"} 1\n');
  });
});
