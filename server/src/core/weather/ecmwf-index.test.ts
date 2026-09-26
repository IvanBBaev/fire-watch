import { describe, expect, it } from 'vitest';

import { WEATHER_CONTEXT } from '../config/weather-context.js';
import { checkGribSanity, selectIndexEntries, toByteRange } from './ecmwf-index.js';

/** One real-shaped index line — note `step` is a string, exactly as ECMWF writes it. */
const indexLine = (param: string, step: string, offset: number, length: number): string =>
  JSON.stringify({
    domain: 'g',
    date: '20260813',
    time: '0600',
    expver: '0001',
    class: 'od',
    type: 'fc',
    stream: 'oper',
    step,
    levtype: 'sfc',
    param,
    _offset: offset,
    _length: length,
  });

const VALUES = WEATHER_CONTEXT.values;

describe('selectIndexEntries', () => {
  it('selects the configured params for one step, in configured order', () => {
    const text = [
      indexLine('2t', '0', 1000, 600),
      indexLine('10u', '0', 0, 609),
      indexLine('msl', '0', 2000, 500), // in the file, not in our set
      indexLine('10u', '6', 9000, 611), // right param, wrong step
    ].join('\n');

    const selection = selectIndexEntries(text, 0, VALUES);
    expect(selection.entries.map((entry) => entry.param)).toEqual(['10u', '2t']);
    expect(selection.entries[0]).toEqual({
      param: '10u',
      levtype: 'sfc',
      step: 0,
      offset: 0,
      length: 609,
    });
    expect(selection.missingParams).toEqual(['10v', '2d', 'tp', 'tcc']);
  });

  it('skips malformed lines without losing the fields around them', () => {
    const text = [
      'not json at all',
      '{"param":"2t"', // truncated JSON
      indexLine('10u', '0', 0, 609),
      JSON.stringify({ param: '2t', levtype: 'sfc', step: '0', _offset: -5, _length: 600 }),
      JSON.stringify({ param: 'tp', levtype: 'sfc', step: '0', _offset: 100, _length: 0 }),
      '',
    ].join('\n');

    const selection = selectIndexEntries(text, 0, VALUES);
    expect(selection.entries.map((entry) => entry.param)).toEqual(['10u']);
  });

  it('resolves duplicate params first-wins', () => {
    const text = [indexLine('10u', '0', 0, 609), indexLine('10u', '0', 5000, 700)].join('\n');
    const selection = selectIndexEntries(text, 0, VALUES);
    expect(selection.entries).toHaveLength(1);
    expect(selection.entries[0]?.offset).toBe(0);
  });

  it('filters on levtype, not just param name', () => {
    const pressureLevel = JSON.stringify({
      param: '2t',
      levtype: 'pl',
      step: '0',
      _offset: 0,
      _length: 900,
    });
    const selection = selectIndexEntries(pressureLevel, 0, VALUES);
    expect(selection.entries).toHaveLength(0);
    expect(selection.missingParams).toContain('2t');
  });

  it('tolerates a numeric step should the provider ever change its mind', () => {
    const numericStep = JSON.stringify({
      param: '10u',
      levtype: 'sfc',
      step: 0,
      _offset: 0,
      _length: 609,
    });
    const selection = selectIndexEntries(numericStep, 0, VALUES);
    expect(selection.entries).toHaveLength(1);
  });
});

describe('toByteRange', () => {
  it('carries the extent through unchanged', () => {
    expect(
      toByteRange({ param: '10u', levtype: 'sfc', step: 0, offset: 123, length: 456 }),
    ).toEqual({ offset: 123, length: 456 });
  });
});

describe('checkGribSanity', () => {
  const validGrib = (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    bytes.set([0x47, 0x52, 0x49, 0x42], 0); // "GRIB"
    bytes.set([0x37, 0x37, 0x37, 0x37], length - 4); // "7777"
    return bytes;
  };

  it('passes a structurally valid field', () => {
    expect(checkGribSanity(validGrib(1200), 1024)).toEqual({ sane: true, reason: null });
  });

  it('rejects a body under the floor before looking at structure', () => {
    const check = checkGribSanity(validGrib(200), 1024);
    expect(check.sane).toBe(false);
    expect(check.reason).toBe('body is 200 bytes, below the 1024-byte floor');
  });

  it('rejects an HTML error page served with a 200', () => {
    const html = new TextEncoder().encode('<html><body>Bad Gateway</body></html>'.repeat(40));
    const check = checkGribSanity(html, 1024);
    expect(check.sane).toBe(false);
    expect(check.reason).toBe('body does not start with the GRIB magic bytes');
  });

  it('rejects a truncated transfer that lost the trailer', () => {
    const bytes = validGrib(1200);
    const truncated = bytes.slice(0, 1100); // magic intact, trailer gone
    const check = checkGribSanity(truncated, 1024);
    expect(check.sane).toBe(false);
    expect(check.reason).toBe('body does not end with the 7777 GRIB trailer');
  });
});
