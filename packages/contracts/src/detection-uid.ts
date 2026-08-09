/**
 * `detection_uid` canonicalization — frozen v1 (GLOSSARY §1b).
 *
 *   detection_uid = lowercase-hex sha256( source | acq_ts_iso | lat_5dp | lon_5dp )
 *
 * Separator is one ASCII pipe, no surrounding whitespace, no trailing separator. Any
 * deviation mints a different id for the same physical detection, and an append-only
 * archive cannot be repaired afterwards — so every element here is pinned, not
 * conventional. Changing rules 1–4 is a `detection_uid_v2` column plus a migration and
 * a new golden-replay baseline, never an in-place edit.
 *
 * This module is deliberately free of crypto and of any platform API: the hash lives in
 * `@fire-watch/contracts/node` so the browser bundle never pulls `node:crypto` in.
 */

import { assertSourceId } from './sources.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^\d{1,4}$/;
const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const INSTANT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z$/;
const ASCII_PRINTABLE_RE = /^[\x20-\x7e]+$/;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * `acq_ts_iso` = `YYYY-MM-DDTHH:MM:00Z`, exactly 20 characters, from a FIRMS
 * `acq_date` + `acq_time` pair.
 *
 * The zero-padding is mandatory: FIRMS delivers `HHMM` without leading zeros, so
 * `"142"` means 01:42 UTC. Seconds are always the literal `00` and the zone is always
 * the literal `Z` — never a local zone, a numeric offset, fractional seconds, or the
 * basic-format variant.
 */
export function canonicalAcqTsIso(acqDate: string, acqTime: string | number): string {
  const dateMatch = DATE_RE.exec(acqDate);
  if (!dateMatch) {
    throw new RangeError(`acq_date must be YYYY-MM-DD, got ${JSON.stringify(acqDate)}`);
  }
  const [, , monthText = '', dayText = ''] = dateMatch;
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12) {
    throw new RangeError(`acq_date month out of range: ${JSON.stringify(acqDate)}`);
  }
  // Leap years are not resolved here: 29 February is accepted for every year, because
  // rejecting a real upstream row is a worse failure than accepting an impossible one.
  const maxDay = DAYS_IN_MONTH[month - 1] ?? 31;
  if (day < 1 || day > maxDay) {
    throw new RangeError(`acq_date day out of range: ${JSON.stringify(acqDate)}`);
  }

  const timeText = typeof acqTime === 'number' ? String(acqTime) : acqTime.trim();
  if (!TIME_RE.test(timeText)) {
    throw new RangeError(`acq_time must be 1–4 digits (HHMM), got ${JSON.stringify(acqTime)}`);
  }
  const padded = timeText.padStart(4, '0');
  const hours = Number(padded.slice(0, 2));
  const minutes = Number(padded.slice(2, 4));
  if (hours > 23 || minutes > 59) {
    throw new RangeError(`acq_time out of range: ${JSON.stringify(acqTime)}`);
  }

  return `${acqDate}T${padded.slice(0, 2)}:${padded.slice(2, 4)}:00Z`;
}

/**
 * Same canonical shape, for sources that deliver a full instant (GEO slot times).
 * Seconds are **truncated** toward the minute, never rounded — rounding would move a
 * detection into the next slot and mint a second uid for it.
 */
export function canonicalAcqTsIsoFromInstant(instant: string): string {
  const match = INSTANT_RE.exec(instant.trim());
  if (!match) {
    throw new RangeError(
      `instant must be YYYY-MM-DDTHH:MM[:SS[.sss]]Z, got ${JSON.stringify(instant)}`,
    );
  }
  const [, date = '', hours = '', minutes = ''] = match;
  return canonicalAcqTsIso(date, `${hours}${minutes}`);
}

/**
 * `lat_5dp` / `lon_5dp` — a decimal string with exactly 5 fraction digits, rounded
 * **half away from zero**, trailing zeros kept, no exponent, negative zero normalized.
 *
 * The input is the decimal text as delivered by the source and is processed as decimal
 * digits. `toFixed` and `printf("%.5f")` are banned *as the specification*: they round
 * the nearest IEEE-754 double, which is half-even at the binary level and
 * platform-dependent at the tie. 5 dp is ~1.1 m — far below any sensor's geolocation
 * accuracy — so the mode never changes clustering; it only has to be byte-stable
 * forever.
 */
export function canonicalDegrees(raw: string | number): string {
  const text = typeof raw === 'number' ? decimalTextFromNumber(raw) : raw.trim();
  const match = DECIMAL_RE.exec(text);
  if (!match) {
    throw new RangeError(
      `coordinate must be a plain decimal (no exponent, no separators), got ${JSON.stringify(raw)}`,
    );
  }
  const [, sign = '', integerText = '', fractionText = ''] = match;

  let integerDigits = integerText;
  let fractionDigits: string;
  if (fractionText.length <= 5) {
    fractionDigits = fractionText.padEnd(5, '0');
  } else {
    fractionDigits = fractionText.slice(0, 5);
    const firstDropped = fractionText.charCodeAt(5) - 48;
    if (firstDropped >= 5) {
      // Round the magnitude up; the sign is reapplied below, which makes this
      // half away from zero rather than half up.
      ({ integerDigits, fractionDigits } = incrementMagnitude(integerDigits, fractionDigits));
    }
  }

  integerDigits = integerDigits.replace(/^0+(?=\d)/, '');
  const isZero = /^0+$/.test(integerDigits) && /^0+$/.test(fractionDigits);
  const canonicalSign = sign === '-' && !isZero ? '-' : '';
  return `${canonicalSign}${integerDigits}.${fractionDigits}`;
}

function incrementMagnitude(
  integerDigits: string,
  fractionDigits: string,
): { integerDigits: string; fractionDigits: string } {
  const digits = (integerDigits + fractionDigits).split('');
  let index = digits.length - 1;
  let carry = 1;
  while (index >= 0 && carry === 1) {
    const value = (digits[index] as string).charCodeAt(0) - 48 + 1;
    if (value === 10) {
      digits[index] = '0';
    } else {
      digits[index] = String(value);
      carry = 0;
    }
    index -= 1;
  }
  const carried = carry === 1 ? ['1', ...digits] : digits;
  const joined = carried.join('');
  return {
    integerDigits: joined.slice(0, joined.length - 5),
    fractionDigits: joined.slice(joined.length - 5),
  };
}

/**
 * A JS number reaches us only from a JSON source that already parsed it. Rendering it
 * back as decimal text is lossy at the 17th significant digit, which is ~12 orders of
 * magnitude below the 5th decimal place, so it cannot move the rounding — but exponent
 * notation would break the parser above, so it is expanded here rather than in the
 * canonicalizer.
 */
function decimalTextFromNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`coordinate must be finite, got ${String(value)}`);
  }
  const text = String(value);
  if (!text.includes('e') && !text.includes('E')) return text;
  // Values this small are indistinguishable from zero at 5 dp.
  return value > 0 ? '0.000000' : '-0.000000';
}

export interface DetectionUidParts {
  /**
   * The §1a canonical id — never an API product name, CSV column or display name.
   *
   * Typed as a plain string on purpose: every caller is an adapter holding a value that
   * came off the wire, so a `SourceId` here would only be an assertion someone made
   * upstream. `assertSourceId` below is the actual check, and it runs on every uid.
   */
  readonly source: string;
  /** Already canonical, or built via `canonicalAcqTsIso`. */
  readonly acqTsIso: string;
  /** Decimal text as delivered by the source, or an already-canonical 5 dp string. */
  readonly lat: string | number;
  readonly lon: string | number;
}

/**
 * The exact bytes that are hashed. Exposed separately so fixtures can assert the
 * pre-image rather than only the digest: a mismatch here is far easier to read than a
 * mismatch in 64 hex characters.
 */
export function detectionUidPreimage(parts: DetectionUidParts): string {
  const source = assertSourceId(parts.source);
  const acqTsIso = parts.acqTsIso.trim();
  if (acqTsIso.length !== 20 || !INSTANT_RE.test(acqTsIso) || !acqTsIso.endsWith(':00Z')) {
    throw new RangeError(
      `acq_ts_iso must be exactly YYYY-MM-DDTHH:MM:00Z, got ${JSON.stringify(parts.acqTsIso)}`,
    );
  }

  const lat = canonicalDegrees(parts.lat);
  const lon = canonicalDegrees(parts.lon);
  assertRange(lat, 90, 'latitude');
  assertRange(lon, 180, 'longitude');

  const preimage = `${source}|${acqTsIso}|${lat}|${lon}`;
  if (!ASCII_PRINTABLE_RE.test(preimage)) {
    throw new RangeError('detection_uid pre-image must be printable ASCII');
  }
  return preimage;
}

function assertRange(canonical: string, limit: number, label: string): void {
  // Bounds only — the canonical string, not this float, is what gets hashed.
  const value = Number(canonical);
  if (value < -limit || value > limit) {
    throw new RangeError(`${label} out of range: ${canonical}`);
  }
}
