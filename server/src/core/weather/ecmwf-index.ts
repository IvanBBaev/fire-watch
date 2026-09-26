/**
 * Reading the ECMWF Open Data `.index` sidecar and judging the GRIB2 bytes it points at
 * (TASKS C4; DATA-SOURCES §D2).
 *
 * The index is JSON lines — one object per field in the big per-step GRIB2 file, with
 * `_offset`/`_length` giving the field's exact byte extent for a Range request. Two
 * provider quirks are load-bearing here: `step` in the index is a **string** ("0", not
 * 0), and unknown/extra lines are normal (the file lists every field in the run, we
 * want six). Parsing is therefore lenient about lines and strict about what it selects.
 *
 * The GRIB sanity check is the weather twin of the EFFIS A2.2 gate: structure only, no
 * decoding — magic, trailer, and a byte floor. A body that fails it is never recorded.
 */

import type { ByteRange } from '../ports/weather-client.js';
import type { WeatherContextValues } from '../config/weather-context.js';

export interface EcmwfIndexEntry {
  readonly param: string;
  readonly levtype: string;
  readonly step: number;
  readonly offset: number;
  readonly length: number;
}

export interface IndexSelection {
  readonly entries: readonly EcmwfIndexEntry[];
  /** Params we wanted that the index does not list — recorded, not silently skipped. */
  readonly missingParams: readonly string[];
}

/**
 * Pick the configured surface fields for one step out of an index body. Malformed lines
 * are skipped (the index is provider-generated bulk output; one bad line must not cost
 * us the other fields), duplicates resolve first-wins, and every requested-but-absent
 * param is reported by name.
 */
export function selectIndexEntries(
  indexText: string,
  step: number,
  values: WeatherContextValues,
): IndexSelection {
  const byParam = new Map<string, EcmwfIndexEntry>();

  for (const line of indexText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = toEntry(record);
    if (entry === null) continue;
    if (entry.levtype !== values.levtype) continue;
    if (entry.step !== step) continue;
    if (!values.params.includes(entry.param)) continue;
    if (!byParam.has(entry.param)) byParam.set(entry.param, entry);
  }

  const entries = values.params
    .filter((param) => byParam.has(param))
    .map((param) => byParam.get(param))
    .filter((entry): entry is EcmwfIndexEntry => entry !== undefined);
  const missingParams = values.params.filter((param) => !byParam.has(param));
  return { entries, missingParams };
}

export function toByteRange(entry: EcmwfIndexEntry): ByteRange {
  return { offset: entry.offset, length: entry.length };
}

export interface GribSanity {
  readonly sane: boolean;
  readonly reason: string | null;
}

/**
 * Structural GRIB2 sanity, no decoding: the 4-byte ASCII `GRIB` magic at offset 0, the
 * `7777` end marker in the last 4 bytes, and a size floor. Catches the realistic
 * failure shapes for a ranged fetch — an HTML error page served with a 200, a range
 * silently truncated mid-transfer — without pretending to validate meteorology.
 */
export function checkGribSanity(bytes: Uint8Array, byteFloorBytes: number): GribSanity {
  if (bytes.byteLength < byteFloorBytes) {
    return {
      sane: false,
      reason:
        `body is ${String(bytes.byteLength)} bytes, below the ` +
        `${String(byteFloorBytes)}-byte floor`,
    };
  }
  // 'G', 'R', 'I', 'B'
  if (bytes[0] !== 0x47 || bytes[1] !== 0x52 || bytes[2] !== 0x49 || bytes[3] !== 0x42) {
    return { sane: false, reason: 'body does not start with the GRIB magic bytes' };
  }
  const n = bytes.byteLength;
  // '7' × 4 — the GRIB2 end-of-message marker.
  if (
    bytes[n - 4] !== 0x37 ||
    bytes[n - 3] !== 0x37 ||
    bytes[n - 2] !== 0x37 ||
    bytes[n - 1] !== 0x37
  ) {
    return { sane: false, reason: 'body does not end with the 7777 GRIB trailer' };
  }
  return { sane: true, reason: null };
}

function toEntry(record: unknown): EcmwfIndexEntry | null {
  if (typeof record !== 'object' || record === null) return null;
  const candidate = record as Record<string, unknown>;
  const param = candidate['param'];
  const levtype = candidate['levtype'];
  const step = candidate['step'];
  const offset = candidate['_offset'];
  const length = candidate['_length'];
  if (typeof param !== 'string' || typeof levtype !== 'string') return null;
  // The index writes step as a string; tolerate a number in case that ever changes.
  const stepNumber = typeof step === 'string' ? Number(step) : step;
  if (typeof stepNumber !== 'number' || !Number.isFinite(stepNumber)) return null;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0) return null;
  return { param, levtype, step: stepNumber, offset, length };
}
