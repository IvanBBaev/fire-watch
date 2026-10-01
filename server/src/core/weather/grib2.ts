/**
 * A deliberately narrow GRIB2 reader: one message, one field, on a regular lat/lon grid —
 * exactly the shape ECMWF Open Data publishes for its surface fields (TASKS F14; A19;
 * DATA-SOURCES §D2).
 *
 * What it accepts, and why only that:
 *
 *   * **Grid template 3.0** (regular lat/lon), scanning `+i` with `-j` or `+j`. The IFS
 *     0.25° grid is 3.0 with scanning mode 0 (north to south, west to east, starting at
 *     180°E). A Gaussian or rotated grid would need a different point lookup, and
 *     silently indexing it as lat/lon puts every arrow in the wrong place.
 *   * **Product template 4.0** (analysis/forecast at a point in time) with the forecast
 *     time in hours — enough to cross-check the run and step we *think* we recorded
 *     against what the message says it is.
 *   * **Data representation 5.0** (simple packing) and **5.42** (CCSDS, `aec.ts`). ECMWF
 *     moved the open data to 5.42; a real `10u` message from the 2026-09-30 00z run is
 *     `grid_ccsds`, 12 bits, block 32, RSI 128, flags 14. 5.0 stays because it is the
 *     GRIB2 baseline and costs twenty lines.
 *   * **No bitmap** (section 6 indicator 255). Surface wind is defined everywhere; a
 *     bitmap would mean a field we did not expect.
 *
 * Everything else is a typed {@link Grib2Refusal} — refused, never guessed. Values are
 * `Y = (R + X·2^E) / 10^D` (GRIB2 regulation 92.9.4), `E` and `D` sign-magnitude.
 */

import { AecRefusal, decodeAec, type AecModeCounts } from './aec.js';

export type Grib2RefusalReason =
  | 'not_grib'
  | 'unsupported_edition'
  | 'truncated'
  | 'missing_section'
  | 'multiple_fields'
  | 'unsupported_grid_template'
  | 'unsupported_scan_mode'
  | 'unsupported_product_template'
  | 'unsupported_time_unit'
  | 'unsupported_packing_template'
  | 'unsupported_bitmap'
  | 'point_count_mismatch'
  | 'ccsds_refused';

export interface Grib2Refusal {
  readonly ok: false;
  readonly reason: Grib2RefusalReason;
  readonly detail: string;
}

export interface Grib2Grid {
  readonly ni: number;
  readonly nj: number;
  /** Degrees; first and last grid point as the message states them. */
  readonly la1: number;
  readonly lo1: number;
  readonly la2: number;
  readonly lo2: number;
  /** Increments in degrees, always positive; direction comes from the scan mode. */
  readonly di: number;
  readonly dj: number;
  /** `true` for scanning mode bit 2 set (+j, south to north). */
  readonly jPositive: boolean;
}

export interface Grib2Field {
  readonly ok: true;
  readonly discipline: number;
  readonly parameterCategory: number;
  readonly parameterNumber: number;
  /** Section 1 reference time, epoch ms (UTC). */
  readonly referenceTimeMs: number;
  /** Section 4 forecast time, hours after the reference time. */
  readonly forecastHours: number;
  /** Section 4 first fixed surface: type (103 = height above ground) and value. */
  readonly surfaceType: number;
  readonly surfaceValue: number;
  readonly packing: 'simple' | 'ccsds';
  readonly grid: Grib2Grid;
  /** Decoded values in the message's scan order, `ni` per row. */
  readonly values: Float64Array;
}

export type Grib2Decode = Grib2Field | Grib2Refusal;

class Refused extends Error {
  readonly reason: Grib2RefusalReason;

  constructor(reason: Grib2RefusalReason, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

/** Decode the single field in `bytes`. Never throws for bad input — refusals are values. */
export function decodeGrib2(bytes: Uint8Array, counts?: AecModeCounts): Grib2Decode {
  try {
    return parse(bytes, counts);
  } catch (error: unknown) {
    if (error instanceof Refused) return { ok: false, reason: error.reason, detail: error.message };
    if (error instanceof AecRefusal) {
      return { ok: false, reason: 'ccsds_refused', detail: `${error.reason}: ${error.message}` };
    }
    throw error;
  }
}

interface Section {
  readonly number: number;
  readonly start: number;
  readonly length: number;
}

function parse(bytes: Uint8Array, counts: AecModeCounts | undefined): Grib2Field {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16 || ascii(bytes, 0, 4) !== 'GRIB') {
    throw new Refused('not_grib', 'body does not start with the GRIB magic bytes');
  }
  if (bytes[7] !== 2) {
    throw new Refused('unsupported_edition', `GRIB edition ${String(bytes[7])} is not 2`);
  }
  const discipline = bytes[6] ?? 0;
  const totalHigh = view.getUint32(8);
  const total = totalHigh * 2 ** 32 + view.getUint32(12);
  if (total > bytes.byteLength) {
    throw new Refused(
      'truncated',
      `message says ${String(total)} bytes, got ${String(bytes.byteLength)}`,
    );
  }

  const sections = new Map<number, Section>();
  let offset = 16;
  for (;;) {
    if (offset + 4 > total) throw new Refused('truncated', 'message ends before section 8');
    if (ascii(bytes, offset, 4) === '7777') break;
    if (offset + 5 > total) throw new Refused('truncated', 'section header is cut off');
    const length = view.getUint32(offset);
    const number = bytes[offset + 4] ?? 0;
    if (length < 5 || offset + length > total) {
      throw new Refused('truncated', `section ${String(number)} overruns the message`);
    }
    if (sections.has(number)) {
      throw new Refused('multiple_fields', `section ${String(number)} repeats in one message`);
    }
    sections.set(number, { number, start: offset, length });
    offset += length;
  }

  const s1 = require(sections, 1);
  const s3 = require(sections, 3);
  const s4 = require(sections, 4);
  const s5 = require(sections, 5);
  const s6 = require(sections, 6);
  const s7 = require(sections, 7);

  const referenceTimeMs = Date.UTC(
    view.getUint16(s1.start + 12),
    (bytes[s1.start + 14] ?? 1) - 1,
    bytes[s1.start + 15] ?? 1,
    bytes[s1.start + 16] ?? 0,
    bytes[s1.start + 17] ?? 0,
    bytes[s1.start + 18] ?? 0,
  );

  const grid = parseGrid(view, bytes, s3);
  const points = grid.ni * grid.nj;
  if (view.getUint32(s3.start + 6) !== points) {
    throw new Refused('point_count_mismatch', 'section 3 point count is not Ni × Nj');
  }

  const productTemplate = view.getUint16(s4.start + 7);
  if (productTemplate !== 0) {
    throw new Refused(
      'unsupported_product_template',
      `product template 4.${String(productTemplate)} is not supported`,
    );
  }
  const timeUnit = bytes[s4.start + 17];
  if (timeUnit !== 1) {
    throw new Refused(
      'unsupported_time_unit',
      `forecast time unit ${String(timeUnit)} is not hours`,
    );
  }
  const forecastHours = view.getUint32(s4.start + 18);
  const surfaceType = bytes[s4.start + 22] ?? 0;
  const surfaceScale = signMagnitude8(bytes[s4.start + 23] ?? 0);
  const surfaceValue = view.getUint32(s4.start + 24) / 10 ** surfaceScale;

  if (view.getUint32(s5.start + 5) !== points) {
    throw new Refused('point_count_mismatch', 'section 5 value count is not Ni × Nj');
  }
  const bitmap = bytes[s6.start + 5];
  if (bitmap !== 255) {
    throw new Refused('unsupported_bitmap', `bitmap indicator ${String(bitmap)} is not 255`);
  }

  const packingTemplate = view.getUint16(s5.start + 9);
  const reference = view.getFloat32(s5.start + 11);
  const binaryScale = signMagnitude16(view.getUint16(s5.start + 15));
  const decimalScale = signMagnitude16(view.getUint16(s5.start + 17));
  const bits = bytes[s5.start + 19] ?? 0;
  const data = bytes.subarray(s7.start + 5, s7.start + s7.length);

  let packed: Float64Array;
  let packing: 'simple' | 'ccsds';
  if (packingTemplate === 0) {
    packing = 'simple';
    packed = unpackSimple(data, points, bits);
  } else if (packingTemplate === 42) {
    packing = 'ccsds';
    packed =
      bits === 0
        ? new Float64Array(points)
        : decodeAec(
            data,
            points,
            {
              bitsPerSample: bits,
              flags: bytes[s5.start + 21] ?? 0,
              blockSize: bytes[s5.start + 22] ?? 0,
              rsi: view.getUint16(s5.start + 23),
            },
            counts,
          );
  } else {
    throw new Refused(
      'unsupported_packing_template',
      `data representation template 5.${String(packingTemplate)} is not supported`,
    );
  }

  const scale = 2 ** binaryScale;
  const divisor = 10 ** decimalScale;
  const values = new Float64Array(points);
  for (let i = 0; i < points; i += 1) {
    values[i] = (reference + (packed[i] ?? 0) * scale) / divisor;
  }

  return {
    ok: true,
    discipline,
    parameterCategory: bytes[s4.start + 9] ?? 0,
    parameterNumber: bytes[s4.start + 10] ?? 0,
    referenceTimeMs,
    forecastHours,
    surfaceType,
    surfaceValue,
    packing,
    grid,
    values,
  };
}

function parseGrid(view: DataView, bytes: Uint8Array, s3: Section): Grib2Grid {
  const template = view.getUint16(s3.start + 12);
  if (template !== 0) {
    throw new Refused(
      'unsupported_grid_template',
      `grid template 3.${String(template)} is not supported`,
    );
  }
  if (s3.length < 72) throw new Refused('truncated', 'section 3 is shorter than template 3.0');
  const at = s3.start;
  const basicAngle = view.getUint32(at + 38);
  const subdivisions = view.getUint32(at + 42);
  // 0 / missing means the default unit of 10⁻⁶ degree.
  const unit =
    basicAngle === 0 || basicAngle === 0xffffffff || subdivisions === 0xffffffff
      ? 1e-6
      : basicAngle / subdivisions;
  const scanMode = bytes[at + 71] ?? 0;
  // Bits (MSB = 1): 1 −i, 2 +j, 3 j-consecutive, 4 boustrophedon. Only bit 2 is accepted.
  if ((scanMode & ~0x40) !== 0) {
    throw new Refused(
      'unsupported_scan_mode',
      `scanning mode 0x${scanMode.toString(16)} is not supported`,
    );
  }
  return {
    ni: view.getUint32(at + 30),
    nj: view.getUint32(at + 34),
    la1: signMagnitude32(view.getUint32(at + 46)) * unit,
    lo1: signMagnitude32(view.getUint32(at + 50)) * unit,
    la2: signMagnitude32(view.getUint32(at + 55)) * unit,
    lo2: signMagnitude32(view.getUint32(at + 59)) * unit,
    di: view.getUint32(at + 63) * unit,
    dj: view.getUint32(at + 67) * unit,
    jPositive: (scanMode & 0x40) !== 0,
  };
}

/**
 * The value at the grid point nearest `(lat, lon)`, or `null` outside the grid. Longitude
 * is taken modulo 360 against `lo1`, because the IFS grid starts at 180°E and wraps.
 */
export function valueNear(field: Grib2Field, lat: number, lon: number): number | null {
  const { grid } = field;
  const rowFloat = grid.jPositive ? (lat - grid.la1) / grid.dj : (grid.la1 - lat) / grid.dj;
  const row = Math.round(rowFloat);
  if (row < 0 || row >= grid.nj) return null;
  const eastOfFirst = (((lon - grid.lo1) % 360) + 360) % 360;
  let col = Math.round(eastOfFirst / grid.di);
  // A global grid's last column is one step west of its first; wrap the rounding.
  if (col === grid.ni && Math.abs(grid.ni * grid.di - 360) < 1e-9) col = 0;
  if (col < 0 || col >= grid.ni) return null;
  return field.values[row * grid.ni + col] ?? null;
}

function unpackSimple(data: Uint8Array, points: number, bits: number): Float64Array {
  const out = new Float64Array(points);
  if (bits === 0) return out;
  if (bits > 32) {
    throw new Refused('unsupported_packing_template', `simple packing of ${String(bits)} bits`);
  }
  if (data.byteLength * 8 < points * bits) {
    throw new Refused('truncated', 'section 7 holds fewer bits than Ni × Nj values');
  }
  let position = 0;
  for (let i = 0; i < points; i += 1) {
    let value = 0;
    let remaining = bits;
    while (remaining > 0) {
      const byte = data[position >>> 3] ?? 0;
      const available = 8 - (position & 7);
      const take = Math.min(available, remaining);
      value = value * 2 ** take + ((byte >>> (available - take)) & ((1 << take) - 1));
      position += take;
      remaining -= take;
    }
    out[i] = value;
  }
  return out;
}

function require(sections: ReadonlyMap<number, Section>, number: number): Section {
  const section = sections.get(number);
  if (section === undefined) {
    throw new Refused('missing_section', `section ${String(number)} is missing`);
  }
  return section;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** GRIB2 signed integers are sign-and-magnitude, not two's complement. */
function signMagnitude32(raw: number): number {
  return raw >= 0x80000000 ? -(raw - 0x80000000) : raw;
}

function signMagnitude16(raw: number): number {
  return raw >= 0x8000 ? -(raw - 0x8000) : raw;
}

function signMagnitude8(raw: number): number {
  return raw >= 0x80 ? -(raw - 0x80) : raw;
}
