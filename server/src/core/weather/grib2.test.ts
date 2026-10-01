import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  REAL_10U_CCSDS,
  REAL_10U_EXPECTED,
  REAL_10U_SIMPLE,
  REAL_10V_CCSDS,
  REAL_10V_EXPECTED,
  REAL_10V_SIMPLE,
  SYNTH_12BIT_CCSDS,
  SYNTH_20BIT_CCSDS,
  SYNTH_6BIT_CCSDS,
  fromBase64,
  synthField,
} from './__fixtures__/grib2-samples.js';
import {
  AEC_DATA_PREPROCESS,
  AEC_DATA_SIGNED,
  AecRefusal,
  decodeAec,
  type AecModeCounts,
} from './aec.js';
import { decodeGrib2, valueNear, type Grib2Decode, type Grib2Field } from './grib2.js';

const zeroCounts = (): AecModeCounts => ({
  zeroBlockRuns: 0,
  secondExtension: 0,
  split: 0,
  uncompressed: 0,
});

function field(decode: Grib2Decode): Grib2Field {
  if (!decode.ok) throw new Error(`refused: ${decode.reason} (${decode.detail})`);
  return decode;
}

function stats(values: Float64Array): Record<string, number> {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return {
    sum,
    first: values[0] ?? NaN,
    mid: values[Math.floor(values.length / 2)] ?? NaN,
    last: values[values.length - 1] ?? NaN,
    min,
    max,
  };
}

/** Start offset of GRIB2 section `number` in a well-formed message. */
function sectionStart(bytes: Uint8Array, number: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 16;
  while (offset < bytes.byteLength - 4) {
    if (bytes[offset + 4] === number) return offset;
    offset += view.getUint32(offset);
  }
  throw new Error(`section ${String(number)} not found`);
}

function mutate(base64: string, change: (bytes: Uint8Array, view: DataView) => void): Uint8Array {
  const bytes = fromBase64(base64);
  change(bytes, new DataView(bytes.buffer));
  return bytes;
}

const refusal = (decode: Grib2Decode): string | null => (decode.ok ? null : decode.reason);

describe('decodeGrib2 — real ECMWF crops (10u/10v, 2026-09-30 00z, ecCodes reference)', () => {
  it.each([
    ['10u ccsds', REAL_10U_CCSDS, REAL_10U_EXPECTED, 2],
    ['10u simple', REAL_10U_SIMPLE, REAL_10U_EXPECTED, 2],
    ['10v ccsds', REAL_10V_CCSDS, REAL_10V_EXPECTED, 3],
    ['10v simple', REAL_10V_SIMPLE, REAL_10V_EXPECTED, 3],
  ] as const)('%s decodes to the values ecCodes reads', (_name, b64, expected, number) => {
    const decoded = field(decodeGrib2(fromBase64(b64)));
    expect(decoded.discipline).toBe(0);
    expect(decoded.parameterCategory).toBe(2);
    expect(decoded.parameterNumber).toBe(number);
    expect(decoded.referenceTimeMs).toBe(Date.UTC(2026, 8, 30, 0));
    expect(decoded.forecastHours).toBe(0);
    expect(decoded.surfaceType).toBe(103);
    expect(decoded.surfaceValue).toBe(10);
    expect(decoded.grid).toEqual({
      ni: 45,
      nj: 29,
      la1: 46,
      lo1: 20,
      la2: 39,
      lo2: 31,
      di: 0.25,
      dj: 0.25,
      jPositive: false,
    });
    // Exact, not approximate: both decoders compute the same float64 expression.
    expect(stats(decoded.values)).toEqual(expected);
  });

  it('the CCSDS and simple packings of one field decode to identical values', () => {
    for (const [ccsds, simple] of [
      [REAL_10U_CCSDS, REAL_10U_SIMPLE],
      [REAL_10V_CCSDS, REAL_10V_SIMPLE],
    ] as const) {
      const a = field(decodeGrib2(fromBase64(ccsds)));
      const b = field(decodeGrib2(fromBase64(simple)));
      expect(a.packing).toBe('ccsds');
      expect(b.packing).toBe('simple');
      expect(Array.from(a.values)).toEqual(Array.from(b.values));
    }
  });

  it('valueNear finds grid points by coordinate and answers null off the grid', () => {
    const u = field(decodeGrib2(fromBase64(REAL_10U_CCSDS)));
    expect(valueNear(u, 46, 20)).toBe(REAL_10U_EXPECTED.first);
    expect(valueNear(u, 39, 31)).toBe(REAL_10U_EXPECTED.last);
    // Nearest point, not interpolation: 0.1° off still lands on the corner.
    expect(valueNear(u, 45.9, 20.1)).toBe(REAL_10U_EXPECTED.first);
    // Row 14 of 29, column 22 of 45 is the middle value.
    expect(valueNear(u, 46 - 14 * 0.25, 20 + 22 * 0.25)).toBe(REAL_10U_EXPECTED.mid);
    expect(valueNear(u, 47, 25)).toBeNull();
    expect(valueNear(u, 42, 32)).toBeNull();
    // Longitude taken modulo 360.
    expect(valueNear(u, 46, 380)).toBe(REAL_10U_EXPECTED.first);
  });

  it('valueNear wraps the last column of a global grid onto the first', () => {
    const u = field(decodeGrib2(fromBase64(REAL_10U_CCSDS)));
    // The same values on a pretend global 0.25° row starting at 180°E.
    const global: Grib2Field = {
      ...u,
      grid: { ...u.grid, ni: 1440, nj: 1, lo1: 180, lo2: 179.75, la1: 0, la2: 0 },
      values: new Float64Array(1440).map((_v, i) => i),
    };
    expect(valueNear(global, 0, 180)).toBe(0);
    expect(valueNear(global, 0, -180)).toBe(0);
    expect(valueNear(global, 0, 179.75)).toBe(1439);
    expect(valueNear(global, 0, 179.9)).toBe(0);
    expect(valueNear(global, 0, 0)).toBe(720);
  });
});

describe('decodeGrib2 — synthetic CCSDS streams (every coding option, exact integers)', () => {
  it.each([
    ['12-bit, RSI 512', SYNTH_12BIT_CCSDS, 12],
    ['20-bit, RSI 128', SYNTH_20BIT_CCSDS, 20],
    ['6-bit, RSI 64', SYNTH_6BIT_CCSDS, 6],
  ] as const)('%s decodes to exactly the generated field', (_name, b64, bits) => {
    const counts = zeroCounts();
    const decoded = field(decodeGrib2(fromBase64(b64), counts));
    expect(decoded.packing).toBe('ccsds');
    expect(decoded.grid.ni * decoded.grid.nj).toBe(2173);
    expect(Array.from(decoded.values)).toEqual(synthField(2173, bits));
    // The field is shaped to reach every option; the counts prove the fixture still does.
    expect(counts.zeroBlockRuns).toBeGreaterThan(0);
    expect(counts.secondExtension).toBeGreaterThan(0);
    expect(counts.split).toBeGreaterThan(0);
    expect(counts.uncompressed).toBeGreaterThan(0);
  });
});

describe('decodeGrib2 — typed refusals, never guesses', () => {
  it('refuses bytes that are not GRIB', () => {
    expect(refusal(decodeGrib2(new TextEncoder().encode('<html>not found</html>')))).toBe(
      'not_grib',
    );
    expect(refusal(decodeGrib2(new Uint8Array(0)))).toBe('not_grib');
  });

  it('refuses GRIB edition 1', () => {
    expect(refusal(decodeGrib2(mutate(REAL_10U_CCSDS, (b) => (b[7] = 1))))).toBe(
      'unsupported_edition',
    );
  });

  it('refuses a truncated message at every cut point', () => {
    const bytes = fromBase64(REAL_10U_CCSDS);
    for (const cut of [20, 100, 200, bytes.byteLength - 5, bytes.byteLength - 1]) {
      expect(refusal(decodeGrib2(bytes.subarray(0, cut)))).toBe('truncated');
    }
  });

  it('refuses a CCSDS body that runs dry', () => {
    // Keep the section framing honest (shrink section 7 and the total) but drop data bytes.
    const whole = fromBase64(REAL_10U_CCSDS);
    const s7 = sectionStart(whole, 7);
    const drop = 400;
    const bytes = new Uint8Array(whole.byteLength - drop);
    bytes.set(whole.subarray(0, whole.byteLength - 4 - drop));
    bytes.set(whole.subarray(whole.byteLength - 4), bytes.byteLength - 4);
    const view = new DataView(bytes.buffer);
    view.setUint32(12, bytes.byteLength);
    view.setUint32(s7, view.getUint32(s7) - drop);
    const decode = decodeGrib2(bytes);
    expect(refusal(decode)).toBe('ccsds_refused');
    expect(decode.ok ? '' : decode.detail).toMatch(/^truncated_stream/);
  });

  it('refuses a non-lat/lon grid template', () => {
    const bytes = mutate(REAL_10U_CCSDS, (b, v) => v.setUint16(sectionStart(b, 3) + 12, 40));
    expect(refusal(decodeGrib2(bytes))).toBe('unsupported_grid_template');
  });

  it.each([0x80, 0x20, 0x10])('refuses scanning mode 0x%s', (mode) => {
    const bytes = mutate(REAL_10U_CCSDS, (b) => (b[sectionStart(b, 3) + 71] = mode));
    expect(refusal(decodeGrib2(bytes))).toBe('unsupported_scan_mode');
  });

  it('accepts +j scanning and reads rows south to north', () => {
    const bytes = mutate(REAL_10U_CCSDS, (b) => (b[sectionStart(b, 3) + 71] = 0x40));
    const decoded = field(decodeGrib2(bytes));
    expect(decoded.grid.jPositive).toBe(true);
    // Row 0 is now at la1 going north, so la1 + 1 row finds row 1.
    expect(valueNear(decoded, 46.25, 20)).toBe(decoded.values[45]);
  });

  it('refuses an ensemble or statistical product template', () => {
    const bytes = mutate(REAL_10U_CCSDS, (b, v) => v.setUint16(sectionStart(b, 4) + 7, 8));
    expect(refusal(decodeGrib2(bytes))).toBe('unsupported_product_template');
  });

  it('refuses a forecast time not in hours', () => {
    const bytes = mutate(REAL_10U_CCSDS, (b) => (b[sectionStart(b, 4) + 17] = 0));
    expect(refusal(decodeGrib2(bytes))).toBe('unsupported_time_unit');
  });

  it.each([2, 3, 40, 41, 200])('refuses data representation template 5.%s', (template) => {
    const bytes = mutate(REAL_10U_CCSDS, (b, v) => v.setUint16(sectionStart(b, 5) + 9, template));
    expect(refusal(decodeGrib2(bytes))).toBe('unsupported_packing_template');
  });

  it('refuses a bitmap', () => {
    const bytes = mutate(REAL_10U_CCSDS, (b) => (b[sectionStart(b, 6) + 5] = 0));
    expect(refusal(decodeGrib2(bytes))).toBe('unsupported_bitmap');
  });

  it('refuses a point count that disagrees with Ni × Nj', () => {
    const bytes = mutate(REAL_10U_CCSDS, (b, v) => v.setUint32(sectionStart(b, 3) + 34, 30));
    expect(refusal(decodeGrib2(bytes))).toBe('point_count_mismatch');
  });

  it('refuses signed CCSDS samples', () => {
    const bytes = mutate(REAL_10U_CCSDS, (b) => {
      const at = sectionStart(b, 5) + 21;
      b[at] = (b[at] ?? 0) | AEC_DATA_SIGNED;
    });
    const decode = decodeGrib2(bytes);
    expect(refusal(decode)).toBe('ccsds_refused');
    expect(decode.ok ? '' : decode.detail).toMatch(/^unsupported_flags/);
  });

  it('refuses a CCSDS block size outside 8/16/32/64', () => {
    const bytes = mutate(REAL_10U_CCSDS, (b) => (b[sectionStart(b, 5) + 22] = 24));
    const decode = decodeGrib2(bytes);
    expect(decode.ok ? '' : decode.detail).toMatch(/^unsupported_block_size/);
  });

  it('never throws on arbitrary corruption: every result is a field or a typed refusal', () => {
    const base = fromBase64(REAL_10U_CCSDS);
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(base.byteLength - 1), fc.nat(255)), {
          minLength: 1,
          maxLength: 8,
        }),
        (edits) => {
          const bytes = base.slice();
          for (const [at, value] of edits) bytes[at] = value;
          const decode = decodeGrib2(bytes);
          if (decode.ok) {
            expect(decode.values).toHaveLength(decode.grid.ni * decode.grid.nj);
          } else {
            expect(typeof decode.reason).toBe('string');
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('decodeAec — parameter refusals', () => {
  const params = { bitsPerSample: 12, blockSize: 32, rsi: 128, flags: AEC_DATA_PREPROCESS };

  it.each([
    [{ ...params, bitsPerSample: 0 }, 'unsupported_bits_per_sample'],
    [{ ...params, bitsPerSample: 33 }, 'unsupported_bits_per_sample'],
    [{ ...params, blockSize: 12 }, 'unsupported_block_size'],
    [{ ...params, rsi: 0 }, 'invalid_rsi'],
    [{ ...params, rsi: 5000 }, 'invalid_rsi'],
    [{ ...params, flags: params.flags | AEC_DATA_SIGNED }, 'unsupported_flags'],
  ] as const)('refuses %o with %s', (bad, reason) => {
    expect(() => decodeAec(new Uint8Array(16), 10, bad)).toThrow(
      expect.objectContaining({ reason }) as unknown,
    );
  });

  it('an empty stream with samples owed is truncated, not zeros', () => {
    expect(() => decodeAec(new Uint8Array(0), 10, params)).toThrow(AecRefusal);
  });

  it('zero samples decode to an empty array without reading', () => {
    expect(decodeAec(new Uint8Array(0), 0, params)).toHaveLength(0);
  });
});
