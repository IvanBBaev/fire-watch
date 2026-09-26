import { describe, expect, it } from 'vitest';

import {
  AVAILABILITY_STALE_MS,
  evaluateUpstreamAvailability,
  parseAvailabilityCsv,
} from './firms-availability.js';

const HEADER = 'data_id,min_date,max_date\n';

/** 2026-08-02T05:00:00Z — five hours into the UTC day. */
const MORNING = Date.parse('2026-08-02T05:00:00Z');

function body(maxDate: string, dataId = 'VIIRS_NOAA20_NRT'): string {
  return `${HEADER}${dataId},2012-01-20,${maxDate}\n`;
}

describe('parseAvailabilityCsv', () => {
  it('reads the rows the provider publishes', () => {
    const rows = parseAvailabilityCsv(
      `${HEADER}MODIS_NRT,2000-11-01,2026-08-02\nVIIRS_SNPP_NRT,2012-01-20,2026-08-01\n`,
    );

    expect(rows).toEqual([
      { dataId: 'MODIS_NRT', minDate: '2000-11-01', maxDate: '2026-08-02' },
      { dataId: 'VIIRS_SNPP_NRT', minDate: '2012-01-20', maxDate: '2026-08-01' },
    ]);
  });

  it('tolerates a reordered or widened header', () => {
    const rows = parseAvailabilityCsv('max_date,data_id\n2026-08-02,VIIRS_SNPP_NRT\n');

    expect(rows).toEqual([{ dataId: 'VIIRS_SNPP_NRT', minDate: null, maxDate: '2026-08-02' }]);
  });

  it('refuses a body that is not this document at all', () => {
    // An HTML error page read as "zero rows" would report every source as absent, which is
    // a different — and much louder — claim than "we could not check".
    expect(() => parseAvailabilityCsv('<html><body>Service Unavailable</body></html>')).toThrow(
      /no data_id\/max_date columns/,
    );
    expect(() => parseAvailabilityCsv('')).toThrow(/empty/);
  });

  it('skips an unreadable row rather than losing the readable ones', () => {
    const rows = parseAvailabilityCsv(`${HEADER},,\nVIIRS_SNPP_NRT,2012-01-20,2026-08-02\n`);

    expect(rows).toEqual([
      { dataId: 'VIIRS_SNPP_NRT', minDate: '2012-01-20', maxDate: '2026-08-02' },
    ]);
  });
});

describe('evaluateUpstreamAvailability', () => {
  it('is fresh while the provider is publishing today', () => {
    const verdict = evaluateUpstreamAvailability({
      product: 'VIIRS_NOAA20_NRT',
      csv: body('2026-08-02'),
      now: MORNING,
    });

    expect(verdict).toEqual({
      product: 'VIIRS_NOAA20_NRT',
      state: 'fresh',
      maxDate: '2026-08-02',
      // The day it published has not ended yet, so the provider owes us nothing.
      ageSeconds: 0,
      reason: null,
    });
  });

  it('is fresh for the first six hours after the last published day ends', () => {
    const verdict = evaluateUpstreamAvailability({
      product: 'VIIRS_NOAA20_NRT',
      csv: body('2026-08-01'),
      now: MORNING,
    });

    expect(verdict.state).toBe('fresh');
    expect(verdict.ageSeconds).toBe(5 * 3600);
  });

  it('goes stale once a source has published nothing for more than six hours', () => {
    // This is the whole point of the check: the poll below returns HTTP 200 and an empty
    // CSV either way, so nothing else in the pipeline can tell these two cases apart.
    const verdict = evaluateUpstreamAvailability({
      product: 'VIIRS_NOAA20_NRT',
      csv: body('2026-08-01'),
      now: MORNING + 2 * 3_600_000,
    });

    expect(verdict.state).toBe('stale');
    expect(verdict.ageSeconds).toBe(7 * 3600);
    expect(verdict.reason).toMatch(/published nothing since 2026-08-01/);
  });

  it('puts the threshold at exactly six hours, exclusive', () => {
    const atThreshold = evaluateUpstreamAvailability({
      product: 'VIIRS_NOAA20_NRT',
      csv: body('2026-08-01'),
      now: Date.parse('2026-08-02T00:00:00Z') + AVAILABILITY_STALE_MS,
    });
    const pastIt = evaluateUpstreamAvailability({
      product: 'VIIRS_NOAA20_NRT',
      csv: body('2026-08-01'),
      now: Date.parse('2026-08-02T00:00:00Z') + AVAILABILITY_STALE_MS + 1,
    });

    expect(atThreshold.state).toBe('fresh');
    expect(pastIt.state).toBe('stale');
  });

  it('honours an overridden threshold', () => {
    const verdict = evaluateUpstreamAvailability({
      product: 'VIIRS_NOAA20_NRT',
      csv: body('2026-08-01'),
      now: MORNING,
      staleAfterMs: 3_600_000,
    });

    expect(verdict.state).toBe('stale');
  });

  it('matches the product however the provider cases it', () => {
    const verdict = evaluateUpstreamAvailability({
      product: 'VIIRS_NOAA20_NRT',
      csv: body('2026-08-02', 'viirs_noaa20_nrt'),
      now: MORNING,
    });

    expect(verdict.state).toBe('fresh');
  });

  it('is unknown — never stale — when the endpoint answers with something else', () => {
    // An availability endpoint that is itself broken says nothing about whether fires are
    // being published. Paging on it would teach an operator to ignore this signal.
    for (const csv of ['<html>502</html>', `${HEADER}MODIS_NRT,2000-11-01,2026-08-02\n`]) {
      const verdict = evaluateUpstreamAvailability({
        product: 'VIIRS_NOAA20_NRT',
        csv,
        now: MORNING,
      });

      expect(verdict.state).toBe('unknown');
      expect(verdict.maxDate).toBeNull();
      expect(verdict.ageSeconds).toBeNull();
      expect(verdict.reason).not.toBeNull();
    }
  });

  it('is unknown when max_date is empty or not a calendar date', () => {
    for (const maxDate of ['', 'yesterday', '2026-02-31']) {
      const verdict = evaluateUpstreamAvailability({
        product: 'VIIRS_NOAA20_NRT',
        csv: body(maxDate),
        now: MORNING,
      });

      expect(verdict.state).toBe('unknown');
    }
  });

  it('never throws, whatever it is handed', () => {
    expect(() =>
      evaluateUpstreamAvailability({ product: 'VIIRS_NOAA20_NRT', csv: '', now: Number.NaN }),
    ).not.toThrow();
  });
});
