/**
 * The in-process metrics registry (TASKS C5): remembers the latest value of every series and
 * renders it through the pure exposition in `core/observability/prometheus-text.ts`.
 *
 * Three ways in, matching the three ways the existing loops already report:
 *
 *   * {@link MetricsRegistry.replaceFamily} — a loop hands over a whole family at once (the
 *     monitors loop's readings). The previous series of that family are dropped, so a
 *     reading that went `null` disappears instead of freezing at its last value.
 *   * {@link MetricsRegistry.setGauge} / {@link MetricsRegistry.incCounter} — one series.
 *   * {@link MetricsRegistry.addCollector} — a function run at scrape time (the API's
 *     freshness verdict, which is only honest if it is computed when asked).
 *
 * A collector that throws or rejects contributes nothing to that scrape and is not allowed
 * to take the other families down with it: a scrape that fails as a whole reads, to
 * Grafana, as `up == 0` — a lie about a process that is serving fine.
 */

import {
  formatExposition,
  type MetricDescriptor,
  type MetricSample,
} from '../../core/observability/prometheus-text.js';

export type MetricsCollector = () => Promise<readonly MetricSample[]> | readonly MetricSample[];

export interface MetricsRegistry {
  replaceFamily(descriptor: MetricDescriptor, samples: readonly MetricSample[]): void;
  setGauge(
    descriptor: MetricDescriptor,
    labels: Readonly<Record<string, string>>,
    value: number,
  ): void;
  incCounter(
    descriptor: MetricDescriptor,
    labels: Readonly<Record<string, string>>,
    by?: number,
  ): void;
  addCollector(collector: MetricsCollector): void;
  /** The exposition of every stored series plus every collector's samples, right now. */
  render(): Promise<string>;
}

/**
 * A registry over a fixed catalogue. Every method refuses a descriptor that is not the one
 * in the catalogue under that name, so a series can never be exported under help text or a
 * kind the catalogue does not declare.
 */
export function createMetricsRegistry(catalog: readonly MetricDescriptor[]): MetricsRegistry {
  const byName = new Map(catalog.map((descriptor) => [descriptor.name, descriptor]));
  /** name → series key → sample */
  const families = new Map<string, Map<string, MetricSample>>();
  const collectors: MetricsCollector[] = [];

  function known(descriptor: MetricDescriptor): void {
    if (byName.get(descriptor.name) !== descriptor) {
      throw new RangeError(`metric ${descriptor.name} is not in this registry's catalogue`);
    }
  }

  function seriesKey(
    descriptor: MetricDescriptor,
    labels: Readonly<Record<string, string>>,
  ): string {
    return JSON.stringify(descriptor.labels.map((label) => labels[label] ?? null));
  }

  function family(name: string): Map<string, MetricSample> {
    let series = families.get(name);
    if (series === undefined) {
      series = new Map();
      families.set(name, series);
    }
    return series;
  }

  return {
    replaceFamily(descriptor, samples) {
      known(descriptor);
      const series = new Map<string, MetricSample>();
      for (const sample of samples) {
        if (sample.name !== descriptor.name) {
          throw new RangeError(`sample ${sample.name} handed over as family ${descriptor.name}`);
        }
        series.set(seriesKey(descriptor, sample.labels), sample);
      }
      families.set(descriptor.name, series);
    },

    setGauge(descriptor, labels, value) {
      known(descriptor);
      if (descriptor.kind !== 'gauge') throw new RangeError(`${descriptor.name} is not a gauge`);
      family(descriptor.name).set(seriesKey(descriptor, labels), {
        name: descriptor.name,
        labels: { ...labels },
        value,
      });
    },

    incCounter(descriptor, labels, by = 1) {
      known(descriptor);
      if (descriptor.kind !== 'counter')
        throw new RangeError(`${descriptor.name} is not a counter`);
      if (!(by >= 0) || !Number.isFinite(by)) {
        throw new RangeError(`counter ${descriptor.name} cannot move by ${String(by)}`);
      }
      const series = family(descriptor.name);
      const key = seriesKey(descriptor, labels);
      const current = series.get(key)?.value ?? 0;
      series.set(key, { name: descriptor.name, labels: { ...labels }, value: current + by });
    },

    addCollector(collector) {
      collectors.push(collector);
    },

    async render() {
      const samples: MetricSample[] = [];
      for (const series of families.values()) samples.push(...series.values());
      const collected = await Promise.allSettled(collectors.map(async (collect) => collect()));
      for (const outcome of collected) {
        if (outcome.status === 'fulfilled') samples.push(...outcome.value);
      }
      return formatExposition(catalog, samples);
    },
  };
}
