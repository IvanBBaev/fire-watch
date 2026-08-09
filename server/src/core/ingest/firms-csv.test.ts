import { describe, expect, it } from 'vitest';

import { FirmsCsvFormatError, parseCsvLine, parseFirmsCsv } from './firms-csv.js';

const VIIRS_HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight';

const MODIS_HEADER =
  'country_id,latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_t31,frp,daynight';

/** Lays values out in the order the given header declares them. */
function layout(header: string, values: Record<string, string>): string {
  return header
    .split(',')
    .map((name) => values[name] ?? '')
    .join(',');
}

/** One VIIRS data row; `overrides` replaces named columns. */
function viirsRow(overrides: Record<string, string> = {}): string {
  return layout(VIIRS_HEADER, {
    country_id: 'BGR',
    latitude: '41.850123',
    longitude: '26.140027',
    bright_ti4: '330.5',
    scan: '0.39',
    track: '0.36',
    acq_date: '2026-08-02',
    acq_time: '1124',
    satellite: 'N',
    instrument: 'VIIRS',
    confidence: 'n',
    version: '2.0NRT',
    bright_ti5: '295.1',
    frp: '12.5',
    daynight: 'D',
    ...overrides,
  });
}

function modisRow(overrides: Record<string, string> = {}): string {
  return layout(MODIS_HEADER, {
    country_id: 'BGR',
    latitude: '41.85012',
    longitude: '26.14003',
    brightness: '320.0',
    scan: '1.1',
    track: '1.0',
    acq_date: '2026-08-02',
    acq_time: '1124',
    satellite: 'Terra',
    instrument: 'MODIS',
    confidence: '75',
    version: '6.1NRT',
    bright_t31: '290.0',
    frp: '5.0',
    daynight: 'D',
    ...overrides,
  });
}

function viirsCsv(...rows: string[]): string {
  return [VIIRS_HEADER, ...rows].join('\n');
}

const parseViirs = (text: string) => parseFirmsCsv(text, { source: 'firms:viirs:snpp' });

describe('parseFirmsCsv — whole-response failures', () => {
  it('rejects an empty body', () => {
    expect(() => parseViirs('')).toThrow(FirmsCsvFormatError);
  });

  it('rejects a response that is not the CSV we asked for', () => {
    // The realistic shape of this failure: an error page, or a rate-limit notice, served
    // with a 200 and a text/plain content type.
    expect(() => parseViirs('Invalid MAP_KEY\n')).toThrow(/missing column/);
    expect(() => parseViirs('Invalid MAP_KEY\n')).toThrow(/Invalid MAP_KEY/);
  });

  it('rejects a MODIS file handed to the VIIRS parser', () => {
    expect(() => parseViirs(MODIS_HEADER)).toThrow(/bright_ti4, bright_ti5/);
  });

  it('accepts a header-only response as a healthy empty poll', () => {
    // "No fires in the box" and "the poll failed" must never look the same (pitfall 10).
    const result = parseViirs(viirsCsv());

    expect(result.rows).toEqual([]);
    expect(result.rejections).toEqual([]);
  });

  it('refuses to parse a non-FIRMS source', () => {
    expect(() => parseFirmsCsv(viirsCsv(), { source: 'eumetsat:slstr:frp' })).toThrow(
      /not a FIRMS product/,
    );
  });
});

describe('parseFirmsCsv — pitfall 1: acq_time is HHMM without leading zeros', () => {
  it('reads "142" as 01:42 UTC', () => {
    const result = parseViirs(viirsCsv(viirsRow({ acq_time: '142' })));

    expect(result.rows[0]?.acqTsIso).toBe('2026-08-02T01:42:00Z');
  });

  it('reads "0" as midnight UTC', () => {
    expect(parseViirs(viirsCsv(viirsRow({ acq_time: '0' }))).rows[0]?.acqTsIso).toBe(
      '2026-08-02T00:00:00Z',
    );
  });

  it('always produces the 20-character canonical minute', () => {
    for (const time of ['5', '35', '935', '2359']) {
      const [row] = parseViirs(viirsCsv(viirsRow({ acq_time: time }))).rows;
      expect(row?.acqTsIso).toHaveLength(20);
      expect(row?.acqTsIso.endsWith(':00Z')).toBe(true);
    }
  });

  it('rejects an impossible time rather than clamping it', () => {
    const result = parseViirs(viirsCsv(viirsRow({ acq_time: '2560' })));

    expect(result.rows).toEqual([]);
    expect(result.rejections[0]?.reason).toMatch(/acq_time out of range/);
  });
});

describe('parseFirmsCsv — pitfall 4: two schemas, two confidence scales', () => {
  it('normalizes the VIIRS categorical scale and keeps the raw value', () => {
    const result = parseViirs(
      viirsCsv(
        viirsRow({ confidence: 'l' }),
        viirsRow({ confidence: 'n', acq_time: '1125' }),
        viirsRow({ confidence: 'h', acq_time: '1126' }),
      ),
    );

    expect(result.rows.map((row) => row.confidence)).toEqual(['low', 'nominal', 'high']);
    expect(result.rows.map((row) => row.confidenceRaw)).toEqual(['l', 'n', 'h']);
  });

  it('normalizes the MODIS numeric scale at the FIRMS boundaries', () => {
    const rows = ['0', '29', '30', '79', '80', '100'].map((confidence, offset) =>
      modisRow({ confidence, acq_time: String(1100 + offset) }),
    );
    const result = parseFirmsCsv([MODIS_HEADER, ...rows].join('\n'), { source: 'firms:modis' });

    expect(result.rejections).toEqual([]);
    expect(result.rows.map((parsed) => parsed.confidence)).toEqual([
      'low',
      'low',
      'nominal',
      'nominal',
      'high',
      'high',
    ]);
  });

  it('rejects a categorical confidence in a MODIS row and says why', () => {
    const result = parseFirmsCsv([MODIS_HEADER, modisRow({ confidence: 'n' })].join('\n'), {
      source: 'firms:modis',
    });

    expect(result.rejections[0]?.reason).toMatch(/VIIRS file is being read with the MODIS parser/);
  });

  it('rejects a numeric confidence in a VIIRS row and says why', () => {
    const result = parseViirs(viirsCsv(viirsRow({ confidence: '85' })));

    expect(result.rejections[0]?.reason).toMatch(/MODIS file is being read with the VIIRS parser/);
  });

  it('reads the family-specific brightness columns', () => {
    const [row] = parseViirs(viirsCsv(viirsRow())).rows;

    expect(row?.brightnessK).toBe(330.5);
    expect(row?.brightnessSecondaryK).toBe(295.1);
  });
});

describe('parseFirmsCsv — pitfall 5: the satellite column decides nothing', () => {
  it('attributes the row to the queried source, whatever the column says', () => {
    const result = parseFirmsCsv(viirsCsv(viirsRow({ satellite: 'Terra' })), {
      source: 'firms:viirs:noaa21',
    });

    expect(result.rows[0]?.source).toBe('firms:viirs:noaa21');
  });

  it('keeps the column for audit', () => {
    const [row] = parseViirs(viirsCsv(viirsRow({ satellite: 'N20' }))).rows;

    expect(row?.satelliteRaw).toBe('N20');
    expect(row?.instrumentRaw).toBe('VIIRS');
    expect(row?.versionRaw).toBe('2.0NRT');
  });
});

describe('parseFirmsCsv — pitfalls 8 and 9: footprint and FRP', () => {
  it('keeps scan and track', () => {
    const [row] = parseViirs(viirsCsv(viirsRow({ scan: '0.52', track: '0.48' }))).rows;

    expect(row?.scanKm).toBe(0.52);
    expect(row?.trackKm).toBe(0.48);
  });

  it('separates an unreported FRP from a reported zero', () => {
    const result = parseViirs(
      viirsCsv(viirsRow({ frp: '' }), viirsRow({ frp: '0', acq_time: '1125' })),
    );

    expect(result.rows[0]?.frpMw).toBe(null);
    expect(result.rows[1]?.frpMw).toBe(0);
  });

  it('rejects a non-numeric footprint instead of letting NaN reach the ε formula', () => {
    const result = parseViirs(viirsCsv(viirsRow({ scan: 'NaN' })));

    expect(result.rows).toEqual([]);
    expect(result.rejections[0]?.reason).toMatch(/scan must be empty or a finite number/);
  });
});

describe('parseFirmsCsv — canonicalization', () => {
  it('produces canonical 5 dp coordinate text, not floats', () => {
    const [row] = parseViirs(
      viirsCsv(viirsRow({ latitude: '41.850125', longitude: '-26.1' })),
    ).rows;

    // Half away from zero, and trailing zeros kept — the id depends on both.
    expect(row?.latCanonical).toBe('41.85013');
    expect(row?.lonCanonical).toBe('-26.10000');
  });

  it('rejects a coordinate outside the globe', () => {
    const result = parseViirs(viirsCsv(viirsRow({ latitude: '91.0' })));

    expect(result.rows).toEqual([]);
    expect(result.rejections[0]?.reason).toMatch(/latitude out of range/);
  });

  it('carries the exact bytes the id will be hashed from', () => {
    const [parsed] = parseViirs(viirsCsv(viirsRow())).rows;

    expect(parsed?.uidPreimage).toBe('firms:viirs:snpp|2026-08-02T11:24:00Z|41.85012|26.14003');
  });

  it('reads D, N and an absent day/night flag', () => {
    const result = parseViirs(
      viirsCsv(
        viirsRow({ daynight: 'D' }),
        viirsRow({ daynight: 'N', acq_time: '1125' }),
        viirsRow({ daynight: '', acq_time: '1126' }),
      ),
    );

    expect(result.rows.map((row) => row.dayNight)).toEqual(['D', 'N', null]);
  });
});

describe('parseFirmsCsv — the rejection channel', () => {
  it('keeps good rows and quarantines bad ones from the same response', () => {
    const result = parseViirs(
      viirsCsv(
        viirsRow(),
        viirsRow({ latitude: 'not-a-number', acq_time: '1125' }),
        viirsRow({ acq_time: '1126' }),
      ),
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.rowIndex).toBe(2);
  });

  it('retains the raw bytes of a rejected row', () => {
    // C2 quarantines these; re-serializing the parsed row would discard the evidence.
    const bad = viirsRow({ latitude: 'not-a-number' });
    const result = parseViirs(viirsCsv(bad));

    expect(result.rejections[0]?.raw).toBe(bad);
  });

  it('numbers rows across both channels so an index means one line', () => {
    const result = parseViirs(
      viirsCsv(viirsRow({ acq_time: '2560' }), viirsRow(), viirsRow({ scan: 'x', acq_time: '1' })),
    );

    expect(result.rejections.map((rejection) => rejection.rowIndex)).toEqual([1, 3]);
    expect(result.rows[0]?.rowIndex).toBe(2);
  });

  it('ignores blank lines, CRLF endings and a UTF-8 BOM', () => {
    const result = parseViirs(`\uFEFF${VIIRS_HEADER}\r\n${viirsRow()}\r\n\r\n`);

    expect(result.rows).toHaveLength(1);
    expect(result.rejections).toEqual([]);
  });
});

describe('parseCsvLine', () => {
  it('splits plain values', () => {
    expect(parseCsvLine('a,b,,c')).toEqual(['a', 'b', '', 'c']);
  });

  it('honours quoted fields and doubled quotes', () => {
    expect(parseCsvLine('"a,b","say ""hi""",c')).toEqual(['a,b', 'say "hi"', 'c']);
  });

  it('keeps a trailing empty field', () => {
    expect(parseCsvLine('a,')).toEqual(['a', '']);
  });
});
