import { describe, expect, it } from 'vitest';

import {
  BBOX_TOLERANCE_DEG,
  MAX_CLOCK_SKEW_MS,
  NADIR_SCAN_KM,
  NADIR_TRACK_KM,
  describeViolations,
  footprintKm,
  partitionByValidity,
  pollWindowStart,
  validateDetection,
  type ValidationContext,
} from './detection-validation.js';
import { parseFirmsCsv, type FirmsRow } from './firms-csv.js';

const SOURCE = 'firms:viirs:snpp';

const HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight';

const AVAILABLE_AT = 1_785_670_170_000; // 2026-08-02T11:29:30Z

interface Cells {
  readonly latitude?: string;
  readonly longitude?: string;
  readonly brightTi4?: string;
  readonly scan?: string;
  readonly track?: string;
  readonly acqDate?: string;
  readonly acqTime?: string;
  readonly brightTi5?: string;
  readonly frp?: string;
}

/** Built through the parser, so the row under test is one the parser actually produces. */
function firmsRow(cells: Cells = {}): FirmsRow {
  const line = [
    'BGR',
    cells.latitude ?? '41.70112',
    cells.longitude ?? '26.14003',
    cells.brightTi4 ?? '330.5',
    cells.scan ?? '0.39',
    cells.track ?? '0.36',
    cells.acqDate ?? '2026-08-02',
    cells.acqTime ?? '1124',
    'N',
    'VIIRS',
    'n',
    '2.0NRT',
    cells.brightTi5 ?? '295.1',
    cells.frp ?? '12.5',
    'D',
  ].join(',');

  const parsed = parseFirmsCsv(`${HEADER}\n${line}\n`, { source: SOURCE });
  const row = parsed.rows[0];
  if (row === undefined) {
    throw new Error(`fixture row did not parse: ${parsed.rejections[0]?.reason ?? 'no reason'}`);
  }
  return row;
}

const context: ValidationContext = { availableAt: AVAILABLE_AT, dayRange: 2 };

function codes(row: FirmsRow, override: Partial<ValidationContext> = {}): readonly string[] {
  return validateDetection(row, { ...context, ...override }).map((violation) => violation.code);
}

describe('validateDetection', () => {
  it('passes a row that is what we asked for', () => {
    expect(validateDetection(firmsRow(), context)).toEqual([]);
  });

  it('carries the delivered bytes on the row, not only on a parser rejection', () => {
    // The quarantine entry for a valid-but-wrong row is only honest if the bytes survive.
    expect(firmsRow({ latitude: '55.00000' }).raw).toContain('55.00000');
  });
});

describe('bbox', () => {
  it('flags a detection outside the polled box', () => {
    expect(codes(firmsRow({ latitude: '55.00000' }))).toEqual(['outside_polling_bbox']);
    expect(codes(firmsRow({ longitude: '10.00000' }))).toEqual(['outside_polling_bbox']);
  });

  it('tolerates the edge, because the box travels as rounded text', () => {
    // 46.0 is the northern edge; a provider-side filter that rounds differently must not
    // quarantine a real fire sitting on the boundary.
    expect(codes(firmsRow({ latitude: String(46 + BBOX_TOLERANCE_DEG / 2) }))).toEqual([]);
    expect(codes(firmsRow({ latitude: String(46 + BBOX_TOLERANCE_DEG * 2) }))).toEqual([
      'outside_polling_bbox',
    ]);
  });

  it('validates against the box a backfill replays under', () => {
    const bbox = { west: 25, south: 41, east: 27, north: 42 };
    expect(codes(firmsRow(), { bbox })).toEqual([]);
    expect(codes(firmsRow({ longitude: '22.00000' }), { bbox })).toEqual(['outside_polling_bbox']);
  });
});

describe('acquisition time', () => {
  it('flags an acquisition stamped after the response reached us', () => {
    // Upstream clock skew, and it would corrupt the fixed batch ordering silently.
    expect(codes(firmsRow({ acqTime: '1200' }))).toEqual(['acquired_after_available']);
  });

  it('allows the minute truncation and a few minutes of benign skew', () => {
    // 11:29:30 available, 11:29 acquired — the same minute, reading 30 s ahead.
    expect(codes(firmsRow({ acqTime: '1129' }))).toEqual([]);
    const withinSkew = new Date(AVAILABLE_AT + MAX_CLOCK_SKEW_MS - 60_000)
      .toISOString()
      .slice(11, 16)
      .replace(':', '');
    expect(codes(firmsRow({ acqTime: withinSkew }))).toEqual([]);
  });

  it('never rewrites the value it flags', () => {
    const [violation] = validateDetection(firmsRow({ acqTime: '1200' }), context);
    expect(violation?.detail).toContain('2026-08-02T12:00:00Z');
    expect(violation?.detail).toContain('never clamped');
  });

  it('flags an acquisition older than the day_range window', () => {
    // day_range=2 covers 1 and 2 August; 31 July is an archive file, not the NRT one.
    expect(codes(firmsRow({ acqDate: '2026-07-31' }))).toEqual(['acquired_before_window']);
    expect(codes(firmsRow({ acqDate: '2026-08-01' }))).toEqual([]);
  });
});

describe('pollWindowStart', () => {
  it('opens day_range-1 whole UTC days before the response', () => {
    expect(new Date(pollWindowStart(AVAILABLE_AT, 2)).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
    expect(new Date(pollWindowStart(AVAILABLE_AT, 1)).toISOString()).toBe(
      '2026-08-02T00:00:00.000Z',
    );
  });

  it('keeps the previous pair of days for a poll that straddles midnight', () => {
    // A response built at 23:59:58 and delivered at 00:00:01 covers 31 July and 1 August.
    // Without the grace, every row in it would quarantine for a few seconds each night.
    const justAfterMidnight = Date.parse('2026-08-02T00:00:01Z');
    expect(new Date(pollWindowStart(justAfterMidnight, 2)).toISOString()).toBe(
      '2026-07-31T00:00:00.000Z',
    );
  });
});

describe('instrument values', () => {
  it('flags a footprint that is present but impossible', () => {
    expect(codes(firmsRow({ scan: '0' }))).toEqual(['footprint_out_of_range']);
    expect(codes(firmsRow({ track: '-0.36' }))).toEqual(['footprint_out_of_range']);
    expect(codes(firmsRow({ scan: '4000' }))).toEqual(['footprint_out_of_range']);
  });

  it('treats a missing footprint as the nadir case, not a violation', () => {
    // The MODIS scan/track guard (review 14 M5): absent is documented, zero is broken.
    expect(codes(firmsRow({ scan: '', track: '' }))).toEqual([]);
  });

  it('accepts a reported zero FRP and refuses a negative one', () => {
    expect(codes(firmsRow({ frp: '0' }))).toEqual([]);
    expect(codes(firmsRow({ frp: '' }))).toEqual([]);
    expect(codes(firmsRow({ frp: '-3' }))).toEqual(['frp_negative']);
  });

  it('flags a brightness outside anything an instrument can report', () => {
    expect(codes(firmsRow({ brightTi4: '65535' }))).toEqual(['brightness_out_of_envelope']);
    expect(codes(firmsRow({ brightTi5: '0' }))).toEqual(['brightness_out_of_envelope']);
  });

  it('reports every problem a row has, not the first', () => {
    const row = firmsRow({ latitude: '55.00000', frp: '-3', scan: '0' });
    expect(codes(row)).toEqual(['outside_polling_bbox', 'footprint_out_of_range', 'frp_negative']);
  });
});

describe('footprintKm', () => {
  it('returns what arrived when something arrived', () => {
    expect(footprintKm({ scanKm: 0.39, trackKm: 0.36 })).toEqual({ scanKm: 0.39, trackKm: 0.36 });
  });

  it('resolves the pinned nadir default so no null reaches the eps formula', () => {
    expect(footprintKm({ scanKm: null, trackKm: null })).toEqual({
      scanKm: NADIR_SCAN_KM,
      trackKm: NADIR_TRACK_KM,
    });
    expect(footprintKm({ scanKm: 0.39, trackKm: null })).toEqual({
      scanKm: 0.39,
      trackKm: NADIR_TRACK_KM,
    });
  });
});

describe('partitionByValidity', () => {
  it('splits the batch and keeps the determinism order on both sides', () => {
    const rows = [
      firmsRow({ latitude: '41.70112' }),
      firmsRow({ latitude: '55.00000' }),
      firmsRow({ latitude: '41.80112' }),
      firmsRow({ frp: '-3' }),
    ];

    const { valid, invalid } = partitionByValidity(rows, context);

    expect(valid.map((row) => row.latCanonical)).toEqual(['41.70112', '41.80112']);
    expect(invalid.map((entry) => entry.violations[0]?.code)).toEqual([
      'outside_polling_bbox',
      'frp_negative',
    ]);
    expect(invalid[0]?.detection.raw).toContain('55.00000');
  });

  it('is a no-op on an empty batch', () => {
    expect(partitionByValidity([], context)).toEqual({ valid: [], invalid: [] });
  });
});

describe('describeViolations', () => {
  it('joins the codes and their details into one operator-readable line', () => {
    const violations = validateDetection(firmsRow({ latitude: '55.00000', frp: '-3' }), context);

    expect(describeViolations(violations)).toMatch(/^outside_polling_bbox: .*; frp_negative: /);
  });
});

describe('misconfiguration', () => {
  it('refuses a context that cannot decide anything', () => {
    expect(() => validateDetection(firmsRow(), { availableAt: Number.NaN })).toThrow(RangeError);
    expect(() => validateDetection(firmsRow(), { ...context, dayRange: 0 })).toThrow(RangeError);
  });
});
