import { describe, expect, it } from 'vitest';

import {
  escapeHelp,
  escapeLabelValue,
  formatExposition,
  formatValue,
  validateCatalog,
  validateDescriptor,
  type MetricDescriptor,
} from './prometheus-text.js';

const GAUGE: MetricDescriptor = {
  name: 'fw_test_gauge',
  kind: 'gauge',
  help: 'A test gauge.',
  labels: ['relation', 'set'],
};
const COUNTER: MetricDescriptor = {
  name: 'fw_test_events_total',
  kind: 'counter',
  help: 'A test counter.',
  labels: ['reason'],
};
const PLAIN: MetricDescriptor = {
  name: 'fw_test_plain',
  kind: 'gauge',
  help: 'No labels.',
  labels: [],
};
const CATALOG = [GAUGE, COUNTER, PLAIN];

describe('escaping', () => {
  it('escapes backslash, double quote and newline in label values', () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it('escapes backslash and newline in HELP, leaving quotes literal', () => {
    expect(escapeHelp('say "hi"\\\nbye')).toBe('say "hi"\\\\\\nbye');
  });

  it('cannot be tricked into injecting a series through a label value', () => {
    const text = formatExposition(CATALOG, [
      { name: 'fw_test_events_total', labels: { reason: 'x"}\nfw_test_plain 1\n#' }, value: 1 },
    ]);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('fw_test_events_total{reason="x\\"}\\nfw_test_plain 1\\n#"} 1');
  });
});

describe('values', () => {
  it('spells the special values the way the format does', () => {
    expect(formatValue(Number.NaN)).toBe('NaN');
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe('-Inf');
    expect(formatValue(-0)).toBe('0');
    expect(formatValue(1.5)).toBe('1.5');
    expect(formatValue(1_700_000_000)).toBe('1700000000');
  });
});

describe('HELP and TYPE', () => {
  it('emits one HELP and one TYPE per family, before its samples', () => {
    const text = formatExposition(CATALOG, [
      { name: 'fw_test_plain', labels: {}, value: 3 },
      { name: 'fw_test_events_total', labels: { reason: 'b' }, value: 2 },
      { name: 'fw_test_events_total', labels: { reason: 'a' }, value: 1 },
    ]);
    expect(text).toBe(
      [
        '# HELP fw_test_events_total A test counter.',
        '# TYPE fw_test_events_total counter',
        'fw_test_events_total{reason="a"} 1',
        'fw_test_events_total{reason="b"} 2',
        '# HELP fw_test_plain No labels.',
        '# TYPE fw_test_plain gauge',
        'fw_test_plain 3',
        '',
      ].join('\n'),
    );
  });

  it('omits families with no samples, and renders nothing for no samples', () => {
    expect(formatExposition(CATALOG, [])).toBe('');
    const text = formatExposition(CATALOG, [{ name: 'fw_test_plain', labels: {}, value: 0 }]);
    expect(text).not.toContain('fw_test_gauge');
    expect(text).not.toContain('fw_test_events_total');
  });
});

describe('label validation', () => {
  it('refuses a sample with an undeclared label, a missing label or an undeclared metric', () => {
    expect(() =>
      formatExposition(CATALOG, [
        { name: 'fw_test_events_total', labels: { reason: 'a', zone: 'x' }, value: 1 },
      ]),
    ).toThrow(/does not declare label zone/);
    expect(() =>
      formatExposition(CATALOG, [{ name: 'fw_test_gauge', labels: { relation: 'r' }, value: 1 }]),
    ).toThrow(/missing label set/);
    expect(() => formatExposition(CATALOG, [{ name: 'fw_nope', labels: {}, value: 1 }])).toThrow(
      /undeclared metric fw_nope/,
    );
  });

  it('refuses two samples of the same series', () => {
    expect(() =>
      formatExposition(CATALOG, [
        { name: 'fw_test_plain', labels: {}, value: 1 },
        { name: 'fw_test_plain', labels: {}, value: 2 },
      ]),
    ).toThrow(/same labels/);
  });

  it('refuses a negative or NaN counter but allows a NaN gauge', () => {
    expect(() =>
      formatExposition(CATALOG, [
        { name: 'fw_test_events_total', labels: { reason: 'a' }, value: -1 },
      ]),
    ).toThrow(/non-negative/);
    expect(() =>
      formatExposition(CATALOG, [
        { name: 'fw_test_events_total', labels: { reason: 'a' }, value: Number.NaN },
      ]),
    ).toThrow(/non-negative/);
    expect(
      formatExposition(CATALOG, [{ name: 'fw_test_plain', labels: {}, value: Number.NaN }]),
    ).toContain('fw_test_plain NaN');
  });

  it.each<[string, MetricDescriptor, RegExp]>([
    ['bad metric name', { ...PLAIN, name: 'fw-bad' }, /not a valid Prometheus name/],
    ['reserved metric prefix', { ...PLAIN, name: '__fw' }, /reserved/],
    ['counter without _total', { ...COUNTER, name: 'fw_events' }, /must end in _total/],
    ['empty help', { ...PLAIN, help: '  ' }, /no HELP/],
    ['bad label name', { ...PLAIN, labels: ['a-b'] }, /invalid label name/],
    ['colon in label name', { ...PLAIN, labels: ['a:b'] }, /invalid label name/],
    ['reserved label prefix', { ...PLAIN, labels: ['__x'] }, /reserved/],
    ['scraper-owned job label', { ...PLAIN, labels: ['job'] }, /owned by the scraper/],
    ['scraper-owned instance label', { ...PLAIN, labels: ['instance'] }, /owned by the scraper/],
    ['duplicate label', { ...PLAIN, labels: ['a', 'a'] }, /twice/],
  ])('refuses a descriptor with a %s', (_, descriptor, message) => {
    expect(() => validateDescriptor(descriptor)).toThrow(message);
  });

  it('refuses a catalogue that declares a name twice', () => {
    expect(() => validateCatalog([PLAIN, { ...PLAIN }])).toThrow(/declared twice/);
  });
});

describe('stable ordering', () => {
  it('sorts families by name and series by label values in declared order, by code unit', () => {
    const samples = [
      { name: 'fw_test_gauge', labels: { set: 'b', relation: 'z' }, value: 1 },
      { name: 'fw_test_gauge', labels: { set: 'a', relation: 'Z' }, value: 2 },
      { name: 'fw_test_gauge', labels: { set: 'a', relation: 'z' }, value: 3 },
      { name: 'fw_test_gauge', labels: { set: 'a', relation: 'ä' }, value: 4 },
      { name: 'fw_test_plain', labels: {}, value: 5 },
    ];
    const text = formatExposition(CATALOG, samples);
    const series = text.split('\n').filter((line) => line.startsWith('fw_test_gauge'));
    expect(series).toEqual([
      'fw_test_gauge{relation="Z",set="a"} 2',
      'fw_test_gauge{relation="z",set="a"} 3',
      'fw_test_gauge{relation="z",set="b"} 1',
      'fw_test_gauge{relation="ä",set="a"} 4',
    ]);
    expect(formatExposition(CATALOG, [...samples].reverse())).toBe(text);
  });
});
