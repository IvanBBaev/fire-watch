/**
 * Reading what the decoder said — on the assumption that it may have been lying.
 *
 * The sandbox (05 §5.6.2 E3) contains a decoder that just parsed hostile bytes with a
 * native library. Containment means the process cannot take us down with it; it does not
 * mean its *output* is trustworthy. If the granule owned the decoder, the JSON on that
 * pipe is the attacker's JSON, and it arrives already past the network boundary — which
 * is why review 05 asks for validation on both sides of the wall, not one.
 *
 * So this module treats the payload exactly like the FIRMS CSV: untrusted text, parsed by
 * total code that returns a reason instead of throwing. Concretely it defends against the
 * four things a JSON pipe can carry that a schema check alone misses:
 *
 * - **`__proto__` as a key.** `JSON.parse` will happily build one, and an object with a
 *   poisoned prototype turns every later property read in the process into attacker
 *   input. The reviver drops it before an object exists.
 * - **`1e999`.** Valid JSON, parses to `Infinity`, and a non-finite FRP propagates into
 *   every arithmetic mean and every distance comparison downstream as a silent NaN.
 * - **Unbounded size.** A row count and a text length are both capped, and the length is
 *   checked *before* `JSON.parse` so a hundred megabytes never becomes a hundred megabytes
 *   of parsed objects.
 * - **A payload about a different granule.** The envelope must echo the source, kind and
 *   slot it was asked about. A decoder that answers about another source — confused or
 *   compromised — would otherwise get rows attributed wherever it liked, and attribution
 *   is what the whole archive is keyed on.
 *
 * WP1 decodes only `frp`. The cloud mask is *recorded*, not joined (DATA-SOURCES §E2), so
 * its granules are archived as bytes and never handed to a parser this season.
 */

import { canonicalDegrees, type SourceId } from '@fire-watch/contracts';

import type { DetectionConfidence } from '../ports/detection-store.js';
import type { GranuleRef } from '../ports/granule-decoder.js';

/** The envelope version. A decoder that speaks a different one is refused, not guessed at. */
export const GRANULE_PAYLOAD_FORMAT = 'fire-watch.granule.v1';

/**
 * How much text the payload may be. A 15-minute SEVIRI slot over the Balkan box is
 * kilobytes of fire pixels on the worst day of a season; a megabyte is three orders of
 * magnitude of headroom and still small enough to parse without thinking about it.
 */
export const MAX_PAYLOAD_CHARS = 1_000_000;

/**
 * How many rows one granule may claim. Every pixel in the polled box would be a few
 * hundred thousand; the fire pixels among them are hundreds. Twenty thousand is far
 * above any real slot and far below the point where the array itself is the problem.
 */
export const MAX_PAYLOAD_ROWS = 20_000;

/** Bound on any single provider string kept verbatim, in characters. */
const MAX_FIELD_CHARS = 256;

/** `YYYY-MM-DDTHH:MM:00Z`, the same minute-truncated form the uid is hashed from. */
const ACQ_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

const CONFIDENCES: ReadonlySet<string> = new Set<string>(['low', 'nominal', 'high']);

/**
 * One decoded fire pixel, in the shape the archive stores. Deliberately the same
 * vocabulary as the FIRMS path — a GEO detection is a detection, and giving it its own
 * row type would mean two ways to write the same table.
 */
export interface GranuleRow {
  /** Canonical decimal text, five fraction digits — the exact text the uid is hashed from. */
  readonly latCanonical: string;
  readonly lonCanonical: string;
  readonly acqTsIso: string;
  readonly frpMw: number | null;
  /**
   * Normalized by the decoder, verified here. The provider's confidence classes are
   * product-specific and belong with the code that reads the product; what the core
   * guarantees is that nothing but these three values can enter the archive, whatever
   * the decoder claims to have found.
   */
  readonly confidence: DetectionConfidence;
  readonly confidenceRaw: string;
  /** The geostationary footprint, along and across scan. `null` when not reported. */
  readonly scanKm: number | null;
  readonly trackKm: number | null;
  readonly brightnessK: number | null;
  readonly brightnessBgK: number | null;
}

export type PayloadResult =
  | { readonly ok: true; readonly rows: readonly GranuleRow[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Turns the decoder's text into rows, or into one reason why it is not rows.
 *
 * Total: every path returns. A `reason` here is a quarantine reason (TASKS C2) — the
 * granule bytes are kept, the payload is refused, and the slot is recorded as missing
 * rather than as empty.
 */
export function parseGranulePayload(ref: GranuleRef, text: string): PayloadResult {
  if (text.length > MAX_PAYLOAD_CHARS) {
    return refuse(
      `payload is ${String(text.length)} characters, over the ${String(MAX_PAYLOAD_CHARS)} cap`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text, dropDangerousKeys) as unknown;
  } catch (error) {
    return refuse(`payload is not JSON: ${describe(error)}`);
  }

  const envelope = asRecord(parsed);
  if (envelope === null) return refuse('payload is not a JSON object');

  const format = envelope['format'];
  if (format !== GRANULE_PAYLOAD_FORMAT) {
    return refuse(
      `payload format is ${render(format)}, expected ${JSON.stringify(GRANULE_PAYLOAD_FORMAT)}`,
    );
  }

  const echoed = checkEcho(ref, envelope);
  if (echoed !== null) return refuse(echoed);

  const detections = envelope['detections'];
  if (!Array.isArray(detections)) {
    return refuse(`payload detections is ${render(detections)}, expected an array`);
  }
  if (detections.length > MAX_PAYLOAD_ROWS) {
    return refuse(
      `payload claims ${String(detections.length)} rows, over the ${String(MAX_PAYLOAD_ROWS)} cap`,
    );
  }

  const rows: GranuleRow[] = [];
  for (const [index, candidate] of detections.entries()) {
    const row = readRow(candidate);
    if (typeof row === 'string') return refuse(`row ${String(index + 1)}: ${row}`);
    rows.push(row);
  }
  return { ok: true, rows };
}

/**
 * The envelope has to be about the granule we handed over. This is the cheapest possible
 * check and the one that stops a compromised decoder from choosing its own attribution.
 */
function checkEcho(ref: GranuleRef, envelope: Record<string, unknown>): string | null {
  const source = envelope['source'];
  if (source !== (ref.source as string)) {
    return `payload source is ${render(source)}, expected ${JSON.stringify(ref.source)}`;
  }
  const kind = envelope['kind'];
  if (kind !== (ref.kind as string)) {
    return `payload kind is ${render(kind)}, expected ${JSON.stringify(ref.kind)}`;
  }
  const slot = envelope['slot'];
  if (slot !== ref.slotIso) {
    return `payload slot is ${render(slot)}, expected ${JSON.stringify(ref.slotIso)}`;
  }
  return null;
}

/** A row, or the reason it is not one. */
function readRow(candidate: unknown): GranuleRow | string {
  const row = asRecord(candidate);
  if (row === null) return `is ${render(candidate)}, expected an object`;

  let latCanonical: string;
  let lonCanonical: string;
  try {
    // The decoder reports degrees; the canonical *text* is minted here, because the uid
    // is hashed from text and a five-decimal string is the only form that round-trips.
    latCanonical = canonicalDegrees(coordinate(row['lat']));
    lonCanonical = canonicalDegrees(coordinate(row['lon']));
  } catch (error) {
    return `coordinates are unusable: ${describe(error)}`;
  }

  const acqTsIso = row['acq'];
  if (typeof acqTsIso !== 'string' || !ACQ_TS_RE.test(acqTsIso)) {
    return `acq is ${render(acqTsIso)}, expected YYYY-MM-DDTHH:MM:00Z`;
  }

  const confidence = row['confidence'];
  if (typeof confidence !== 'string' || !CONFIDENCES.has(confidence)) {
    return `confidence is ${render(confidence)}, expected low, nominal or high`;
  }

  const confidenceRaw = row['confidenceRaw'];
  if (typeof confidenceRaw !== 'string' || confidenceRaw === '') {
    return `confidenceRaw is ${render(confidenceRaw)}, expected a non-empty string`;
  }
  if (confidenceRaw.length > MAX_FIELD_CHARS) {
    return `confidenceRaw is ${String(confidenceRaw.length)} characters, over the cap`;
  }

  const numbers = new Map<string, number | null>();
  for (const field of ['frpMw', 'scanKm', 'trackKm', 'brightnessK', 'brightnessBgK'] as const) {
    const value = optionalNumber(row[field]);
    if (typeof value === 'string') return `${field} ${value}`;
    numbers.set(field, value);
  }

  return {
    latCanonical,
    lonCanonical,
    acqTsIso,
    confidence: confidence as DetectionConfidence,
    confidenceRaw,
    frpMw: numbers.get('frpMw') ?? null,
    scanKm: numbers.get('scanKm') ?? null,
    trackKm: numbers.get('trackKm') ?? null,
    brightnessK: numbers.get('brightnessK') ?? null,
    brightnessBgK: numbers.get('brightnessBgK') ?? null,
  };
}

/**
 * `null` and a missing key both mean "not reported" and stay null; anything non-finite is
 * a refusal. `1e999` is valid JSON and parses to `Infinity`, and an infinite FRP does not
 * announce itself — it becomes a NaN three functions later, in a mean nobody is watching.
 */
function optionalNumber(value: unknown): number | null | string {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `is ${render(value)}, expected a finite number or null`;
  }
  return value;
}

/** Coordinates are the one field with no "not reported" case: a pixel without a position. */
function coordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`expected a finite number, got ${render(value)}`);
  }
  return value;
}

/**
 * `JSON.parse` builds `__proto__` as a real prototype link, and `constructor`/`prototype`
 * are the same trick one step removed. Dropping them at the reviver is the only place
 * where the object does not exist yet.
 */
function dropDangerousKeys(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function refuse(reason: string): PayloadResult {
  return { ok: false, reason };
}

/** A bounded, quotable rendering of whatever arrived — including the things JSON cannot. */
function render(value: unknown): string {
  const text =
    typeof value === 'number' && !Number.isFinite(value)
      ? String(value)
      : (JSON.stringify(value) ?? String(value));
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported so a caller reading rows does not have to reach into the ports layer. */
export type { SourceId };
