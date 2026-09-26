import { describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../config/polling-bbox.js';
import { defineConfig } from '../config/versioned-config.js';
import type { DetectionUidFn } from '../ports/firms-client.js';
import { parseFirmsCsv } from './firms-csv.js';
import {
  parityCheck,
  referenceFromCsv,
  renderParityReport,
  type OurParityRow,
  type ParityInput,
  type ParityRow,
} from './parity-check.js';
import { PARITY_CHECK } from './parity-params.js';

const SNPP = 'firms:viirs:snpp' as const;
const NOAA20 = 'firms:viirs:noaa20' as const;
const FROM = Date.parse('2026-08-20T00:00:00Z');
const TO = Date.parse('2026-08-21T00:00:00Z');
const WINDOW = { fromMs: FROM, toMs: TO };
const T = (hhmm: string): number => Date.parse(`2026-08-20T${hhmm}:00Z`);

const row = (uid: string, overrides: Partial<ParityRow> = {}): ParityRow => ({
  detectionUid: uid,
  source: SNPP,
  acqTsMs: T('10:00'),
  lat: 42.5,
  lon: 25.0,
  ...overrides,
});

const ours = (uid: string, overrides: Partial<OurParityRow> = {}): OurParityRow => ({
  ...row(uid),
  quarantined: false,
  ...overrides,
});

const NEAR = defineConfig('parity_check', 'parity_check_v9', {
  nearMatch: { acqToleranceMinutes: 1, coordToleranceDeg: 0.001 },
});

function input(overrides: Partial<ParityInput> = {}): ParityInput {
  return {
    window: WINDOW,
    references: [{ source: SNPP, rows: [row('a'), row('b')], rejected: 0 }],
    ours: [ours('a'), ours('b')],
    bbox: POLLING_BBOX,
    config: PARITY_CHECK,
    ...overrides,
  };
}

describe('the shipped parity config', () => {
  it('leaves near-matching off: both tolerances are founder decisions', () => {
    expect(PARITY_CHECK.values.nearMatch).toEqual({
      acqToleranceMinutes: null,
      coordToleranceDeg: null,
    });
  });
});

describe('parityCheck', () => {
  it('reports parity when every reference uid is ours', () => {
    const report = parityCheck(input());
    expect(report.verdict).toBe('parity');
    expect(report.sources[0]).toMatchObject({ matched: 2, missing: 0, extra: 0 });
    expect(report.configVersion).toBe('parity_check_v1');
    expect(report.bboxVersion).toBe(POLLING_BBOX.version);
    expect(report.window).toEqual({ from: '2026-08-20T00:00:00Z', to: '2026-08-21T00:00:00Z' });
  });

  it('fails on a missing row and only reports an extra one', () => {
    const report = parityCheck(input({ ours: [ours('b'), ours('z', { quarantined: true })] }));
    expect(report.verdict).toBe('deficit');
    expect(report.sources[0]).toMatchObject({
      matched: 1,
      missing: 1,
      extra: 1,
      missingUids: ['a'],
      extraUids: ['z'],
      ours: { rows: 2, quarantined: 1 },
    });
    expect(parityCheck(input({ ours: [ours('a'), ours('b'), ours('z')] })).verdict).toBe('parity');
  });

  it('counts out-of-window, out-of-bbox and duplicate rows instead of comparing them', () => {
    const report = parityCheck(
      input({
        references: [
          {
            source: SNPP,
            rows: [
              row('a'),
              row('a'),
              row('early', { acqTsMs: FROM - 1 }),
              row('edge', { acqTsMs: TO }),
              row('far', { lat: 50 }),
              row('corner', { lat: 46, lon: 31 }),
            ],
            rejected: 3,
          },
        ],
        ours: [
          ours('a'),
          ours('corner'),
          ours('late', { acqTsMs: TO + 1 }),
          ours('west', { lon: 19.9 }),
        ],
      }),
    );
    expect(report.sources[0]).toMatchObject({
      reference: { rows: 2, rejected: 3, duplicates: 1, outOfWindow: 2, outsideBbox: 1 },
      ours: { rows: 2, outOfWindow: 1, outsideBbox: 1 },
      matched: 2,
      missing: 0,
      extra: 0,
    });
  });

  it('compares per source and ignores our rows of sources with no reference', () => {
    const report = parityCheck(
      input({
        references: [
          { source: SNPP, rows: [row('a')], rejected: 0 },
          { source: NOAA20, rows: [row('n', { source: NOAA20 })], rejected: 0 },
        ],
        ours: [ours('a'), ours('n'), ours('m', { source: 'firms:viirs:noaa21' })],
      }),
    );
    expect(report.sources.map((s) => [s.source, s.matched, s.missing, s.extra])).toEqual([
      [NOAA20, 0, 1, 0],
      [SNPP, 1, 0, 1],
    ]);
  });

  it('refuses two references for one source', () => {
    expect(() =>
      parityCheck(
        input({
          references: [
            { source: SNPP, rows: [], rejected: 0 },
            { source: SNPP, rows: [], rejected: 0 },
          ],
        }),
      ),
    ).toThrow('more than once');
  });

  it('renders the same bytes for any input order', () => {
    const one = input({ ours: [ours('b'), ours('x'), ours('y')] });
    const two = input({
      references: [{ source: SNPP, rows: [row('b'), row('a')], rejected: 0 }],
      ours: [ours('y'), ours('x'), ours('b')],
    });
    expect(renderParityReport(parityCheck(two))).toBe(renderParityReport(parityCheck(one)));
  });

  describe('near matches', () => {
    it('are off under the shipped config', () => {
      const report = parityCheck(input({ ours: [ours('a2', { acqTsMs: T('10:01') }), ours('b')] }));
      expect(report.sources[0]).toMatchObject({ nearMatched: 0, missing: 1, extra: 1 });
    });

    it('pair a missing row with the closest unclaimed extra inside both tolerances', () => {
      const report = parityCheck(
        input({
          config: NEAR,
          ours: [
            ours('b'),
            ours('far', { acqTsMs: T('10:02') }),
            ours('close', { acqTsMs: T('10:01'), lat: 42.50001 }),
            ours('closer', { acqTsMs: T('10:01') }),
          ],
        }),
      );
      expect(report.verdict).toBe('parity');
      expect(report.sources[0]).toMatchObject({
        nearMatched: 1,
        missing: 0,
        extra: 2,
        extraUids: ['close', 'far'],
        nearMatches: [
          { referenceUid: 'a', ourUid: 'closer', acqDeltaMs: 60_000, latDelta: 0, lonDelta: 0 },
        ],
      });
    });

    it('refuse a half-set tolerance', () => {
      const half = defineConfig('parity_check', 'parity_check_v9', {
        nearMatch: { acqToleranceMinutes: 1, coordToleranceDeg: null },
      });
      expect(() => parityCheck(input({ config: half }))).toThrow('both be null or both be set');
    });
  });
});

describe('referenceFromCsv', () => {
  it('hashes each parsed row with the injected uid function and counts rejections', () => {
    const header =
      'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
      'instrument,confidence,version,bright_ti5,frp,daynight';
    const good =
      'BGR,41.850123,26.140027,330.5,0.39,0.36,2026-08-20,1124,N,VIIRS,n,2.0NRT,295.1,12.5,D';
    const bad =
      'BGR,not-a-lat,26.140027,330.5,0.39,0.36,2026-08-20,1124,N,VIIRS,n,2.0NRT,295.1,12.5,D';
    const parsed = parseFirmsCsv([header, good, bad].join('\n'), { source: SNPP });
    const uid: DetectionUidFn = (p) => `${p.source}|${p.acqTsIso}|${p.lat}|${p.lon}`;

    const reference = referenceFromCsv(parsed, uid);

    expect(reference.source).toBe(SNPP);
    expect(reference.rejected).toBe(1);
    expect(reference.rows).toEqual([
      {
        detectionUid: `firms:viirs:snpp|${parsed.rows[0]?.acqTsIso ?? ''}|${parsed.rows[0]?.latCanonical ?? ''}|${parsed.rows[0]?.lonCanonical ?? ''}`,
        source: SNPP,
        acqTsMs: T('11:24'),
        lat: 41.85012,
        lon: 26.14003,
      },
    ]);
  });
});
