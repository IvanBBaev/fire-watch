/**
 * Prometheus text exposition, version 0.0.4 (TASKS C5, the Grafana Cloud leg; OPERATIONS §3).
 *
 * Pure: descriptors and samples in, one string out. No clock, no registry, no I/O — the
 * stateful registry that remembers the latest gauge values lives in
 * `adapters/metrics/metrics-registry.ts`, and the HTTP surface that serves the string lives
 * in `adapters/http/metrics-server.ts`.
 *
 * Four properties are load-bearing, and each has a test:
 *
 *   * **Escaping.** A label value escapes `\`, `"` and newline; a HELP text escapes `\` and
 *     newline. A relation name or a source id can never break a line and inject a series.
 *   * **HELP/TYPE.** Every family that has samples gets exactly one of each, before its
 *     samples. A family with no samples is omitted entirely rather than exported empty.
 *   * **Label validation.** Metric and label names follow the Prometheus grammar; a sample
 *     must carry exactly its descriptor's labels — no more, no fewer; `job` and `instance`
 *     are refused because the scraper owns them (a `job` label here would silently become
 *     `exported_job`); `__`-prefixed names are reserved. A counter must be named `_total`.
 *   * **Stable ordering.** Families sort by name, series by their label values in the
 *     descriptor's label order, by UTF-16 code unit (never locale). Two scrapes of the same
 *     state are byte-identical, which is what makes an exposition diffable in a test.
 *
 * Validation throws `RangeError`: a bad sample is a programming error in whoever built it,
 * and an exposition that quietly dropped it would be a gauge that silently stopped moving.
 */

import type { MetricDescriptor } from './alert-metrics.js';

export type { MetricDescriptor };

export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** The `Content-Type` a scraper expects for this format. */
export const PROMETHEUS_TEXT_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Labels the scraper attaches to every series; a target must never set them itself. */
export const RESERVED_LABEL_NAMES: readonly string[] = ['job', 'instance'];

/** Throws unless the descriptor could be exported as declared. */
export function validateDescriptor(descriptor: MetricDescriptor): void {
  const { name, kind, help, labels } = descriptor;
  if (!METRIC_NAME_RE.test(name)) {
    throw new RangeError(`metric name ${JSON.stringify(name)} is not a valid Prometheus name`);
  }
  if (name.startsWith('__')) {
    throw new RangeError(`metric name ${name} uses the reserved "__" prefix`);
  }
  if (kind === 'counter' && !name.endsWith('_total')) {
    throw new RangeError(`counter ${name} must end in _total`);
  }
  if (kind !== 'counter' && kind !== 'gauge') {
    throw new RangeError(`metric ${name} has unknown kind ${JSON.stringify(kind)}`);
  }
  if (help.trim() === '') {
    throw new RangeError(`metric ${name} has no HELP text`);
  }
  const seen = new Set<string>();
  for (const label of labels) {
    if (!LABEL_NAME_RE.test(label)) {
      throw new RangeError(`metric ${name} has invalid label name ${JSON.stringify(label)}`);
    }
    if (label.startsWith('__')) {
      throw new RangeError(`metric ${name} label ${label} uses the reserved "__" prefix`);
    }
    if (RESERVED_LABEL_NAMES.includes(label)) {
      throw new RangeError(`metric ${name} label ${label} is owned by the scraper`);
    }
    if (seen.has(label)) {
      throw new RangeError(`metric ${name} declares label ${label} twice`);
    }
    seen.add(label);
  }
}

/** Throws unless every descriptor is valid and no name is declared twice. */
export function validateCatalog(descriptors: readonly MetricDescriptor[]): void {
  const names = new Set<string>();
  for (const descriptor of descriptors) {
    validateDescriptor(descriptor);
    if (names.has(descriptor.name)) {
      throw new RangeError(`metric ${descriptor.name} is declared twice`);
    }
    names.add(descriptor.name);
  }
}

/** Throws unless `sample` is a legal series of `descriptor`. */
export function validateSample(descriptor: MetricDescriptor, sample: MetricSample): void {
  if (sample.name !== descriptor.name) {
    throw new RangeError(`sample ${sample.name} checked against descriptor ${descriptor.name}`);
  }
  const given = Object.keys(sample.labels);
  for (const label of given) {
    if (!descriptor.labels.includes(label)) {
      throw new RangeError(`metric ${descriptor.name} does not declare label ${label}`);
    }
  }
  for (const label of descriptor.labels) {
    const value = sample.labels[label];
    if (typeof value !== 'string') {
      throw new RangeError(`metric ${descriptor.name} sample is missing label ${label}`);
    }
  }
  if (typeof sample.value !== 'number') {
    throw new RangeError(`metric ${descriptor.name} sample value is not a number`);
  }
  if (descriptor.kind === 'counter' && !(sample.value >= 0)) {
    // `!(x >= 0)` is also true for NaN, which a counter can never be.
    throw new RangeError(
      `counter ${descriptor.name} must be a non-negative number, got ${String(sample.value)}`,
    );
  }
}

/** Label value escaping: backslash, double quote, line feed. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** HELP escaping: backslash and line feed only — a quote is literal there. */
export function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** The value as the format spells it: `NaN`, `+Inf`, `-Inf`, and no `-0`. */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  if (Object.is(value, -0)) return '0';
  return String(value);
}

/**
 * Renders the exposition. Every sample must name a descriptor in `descriptors`; two samples
 * with the same name and label values are refused, because a scraper would keep one of
 * them arbitrarily.
 */
export function formatExposition(
  descriptors: readonly MetricDescriptor[],
  samples: readonly MetricSample[],
): string {
  validateCatalog(descriptors);
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const families = new Map<string, { key: string[]; line: string }[]>();

  for (const sample of samples) {
    const descriptor = byName.get(sample.name);
    if (descriptor === undefined) {
      throw new RangeError(`sample names undeclared metric ${sample.name}`);
    }
    validateSample(descriptor, sample);
    const key = descriptor.labels.map((label) => sample.labels[label] ?? '');
    const rendered =
      descriptor.labels.length === 0
        ? ''
        : `{${descriptor.labels
            .map((label, i) => `${label}="${escapeLabelValue(key[i] ?? '')}"`)
            .join(',')}}`;
    const series = families.get(descriptor.name) ?? [];
    series.push({ key, line: `${descriptor.name}${rendered} ${formatValue(sample.value)}` });
    families.set(descriptor.name, series);
  }

  const lines: string[] = [];
  for (const name of [...families.keys()].sort(compareCodeUnits)) {
    const descriptor = byName.get(name);
    const series = families.get(name);
    if (descriptor === undefined || series === undefined) continue;
    series.sort((a, b) => compareKeys(a.key, b.key));
    for (let i = 1; i < series.length; i += 1) {
      const previous = series[i - 1];
      const current = series[i];
      if (
        previous !== undefined &&
        current !== undefined &&
        compareKeys(previous.key, current.key) === 0
      ) {
        throw new RangeError(`metric ${name} has two samples with the same labels`);
      }
    }
    lines.push(`# HELP ${name} ${escapeHelp(descriptor.help)}`);
    lines.push(`# TYPE ${name} ${descriptor.kind}`);
    for (const entry of series) lines.push(entry.line);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareKeys(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const order = compareCodeUnits(a[i] ?? '', b[i] ?? '');
    if (order !== 0) return order;
  }
  return a.length - b.length;
}
