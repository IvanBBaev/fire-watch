/**
 * Orbital elements as CelesTrak publishes them: one CCSDS OMM record per satellite, in the
 * JSON rendering (`gp.php?CATNR=<n>&FORMAT=JSON`, DATA-SOURCES §F15).
 *
 * This file is the trust boundary for those bytes. The refresh job stores a body only when
 * {@link parseOmmBody} accepts it, and the pass route re-parses what it reads, so a
 * truncated or wrong-satellite body can never reach the propagator. Acceptance is
 * deliberately narrow: exactly one record, for the catalogue number that was asked for,
 * SGP4 mean elements (`EPHEMERIS_TYPE` 0), finite numbers, a near-circular low orbit —
 * everything a fire-detecting polar orbiter is and a mis-routed response is not.
 */

import { SatRecError, json2satrec, type OMMJsonObject, type SatRec } from 'satellite.js';

import type { EpochMs } from '../ports/clock.js';

/** The fields SGP4 reads, as numbers; plus the two names a reader or an operator needs. */
export interface OmmRecord {
  readonly objectName: string;
  readonly objectId: string;
  readonly noradId: number;
  /** Element-set epoch, UTC. What "how old are these elements" is measured from. */
  readonly epochMs: EpochMs;
  readonly meanMotionRevPerDay: number;
  readonly eccentricity: number;
  readonly inclinationDeg: number;
  readonly raOfAscNodeDeg: number;
  readonly argOfPericenterDeg: number;
  readonly meanAnomalyDeg: number;
  readonly bstar: number;
  readonly meanMotionDot: number;
  readonly meanMotionDdot: number;
  readonly elementSetNo: number;
  readonly revAtEpoch: number;
}

export type OmmParseResult =
  | { readonly ok: true; readonly record: OmmRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * `YYYY-MM-DDTHH:MM:SS(.ffffff)?` with no zone: OMM epochs are UTC by definition
 * (`TIME_SYSTEM` defaults to UTC), and `Date.parse` would read a zone-less string as local
 * time — so the string is taken apart by hand rather than trusted to it.
 */
const OMM_EPOCH_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z?$/;

/** A polar LEO sits at ~14.2–14.3 rev/day; anything outside this band is not one of ours. */
const MIN_MEAN_MOTION = 13;
const MAX_MEAN_MOTION = 16;
/** Sun-synchronous orbits are near-circular; a large eccentricity means a mis-routed body. */
const MAX_ECCENTRICITY = 0.01;

export function parseOmmEpoch(text: string): EpochMs | null {
  const match = OMM_EPOCH_RE.exec(text);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, frac] = match;
  const fractionMs = frac === undefined ? 0 : Number(`0.${frac}`) * 1000;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(ms)) return null;
  // Date.UTC normalises 2026-02-31 into March; a round-trip catches it.
  const check = new Date(ms);
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) return null;
  return ms + fractionMs;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const raw = record[key];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const raw = record[key];
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null;
}

/** One OMM object → a validated record, for the catalogue number that was asked for. */
export function parseOmmObject(value: unknown, expectedNoradId: number): OmmParseResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'OMM record is not an object' };
  }
  const record = value as Record<string, unknown>;
  const noradId = numberField(record, 'NORAD_CAT_ID');
  if (noradId !== expectedNoradId) {
    return {
      ok: false,
      reason: `OMM is for NORAD ${String(noradId)}, expected ${String(expectedNoradId)}`,
    };
  }
  const ephemerisType = record['EPHEMERIS_TYPE'];
  if (ephemerisType !== undefined && ephemerisType !== 0 && ephemerisType !== '0') {
    return { ok: false, reason: 'OMM is not SGP4 mean elements (EPHEMERIS_TYPE is not 0)' };
  }
  const objectName = stringField(record, 'OBJECT_NAME');
  const objectId = stringField(record, 'OBJECT_ID');
  const epochText = stringField(record, 'EPOCH');
  const epochMs = epochText === null ? null : parseOmmEpoch(epochText);
  if (objectName === null || objectId === null || epochMs === null) {
    return { ok: false, reason: 'OMM is missing OBJECT_NAME, OBJECT_ID or a UTC EPOCH' };
  }
  const fields = {
    meanMotionRevPerDay: numberField(record, 'MEAN_MOTION'),
    eccentricity: numberField(record, 'ECCENTRICITY'),
    inclinationDeg: numberField(record, 'INCLINATION'),
    raOfAscNodeDeg: numberField(record, 'RA_OF_ASC_NODE'),
    argOfPericenterDeg: numberField(record, 'ARG_OF_PERICENTER'),
    meanAnomalyDeg: numberField(record, 'MEAN_ANOMALY'),
    bstar: numberField(record, 'BSTAR'),
    meanMotionDot: numberField(record, 'MEAN_MOTION_DOT'),
    meanMotionDdot: numberField(record, 'MEAN_MOTION_DDOT'),
    elementSetNo: numberField(record, 'ELEMENT_SET_NO'),
    revAtEpoch: numberField(record, 'REV_AT_EPOCH') ?? 0,
  };
  for (const [key, field] of Object.entries(fields)) {
    if (field === null) return { ok: false, reason: `OMM field ${key} is missing or not finite` };
  }
  const parsed: OmmRecord = {
    objectName,
    objectId,
    noradId,
    epochMs,
    meanMotionRevPerDay: fields.meanMotionRevPerDay ?? 0,
    eccentricity: fields.eccentricity ?? 0,
    inclinationDeg: fields.inclinationDeg ?? 0,
    raOfAscNodeDeg: fields.raOfAscNodeDeg ?? 0,
    argOfPericenterDeg: fields.argOfPericenterDeg ?? 0,
    meanAnomalyDeg: fields.meanAnomalyDeg ?? 0,
    bstar: fields.bstar ?? 0,
    meanMotionDot: fields.meanMotionDot ?? 0,
    meanMotionDdot: fields.meanMotionDdot ?? 0,
    elementSetNo: fields.elementSetNo ?? 0,
    revAtEpoch: fields.revAtEpoch,
  };
  if (
    parsed.meanMotionRevPerDay < MIN_MEAN_MOTION ||
    parsed.meanMotionRevPerDay > MAX_MEAN_MOTION
  ) {
    return { ok: false, reason: 'OMM mean motion is not a low-Earth polar orbit' };
  }
  if (parsed.eccentricity < 0 || parsed.eccentricity > MAX_ECCENTRICITY) {
    return { ok: false, reason: 'OMM eccentricity is outside the near-circular band' };
  }
  if (parsed.inclinationDeg < 0 || parsed.inclinationDeg > 180) {
    return { ok: false, reason: 'OMM inclination is not an angle' };
  }
  const satrec = satrecFromOmm(parsed);
  if (satrec.error !== SatRecError.None) {
    return { ok: false, reason: `SGP4 refused the elements (error ${String(satrec.error)})` };
  }
  return { ok: true, record: parsed };
}

/**
 * A CelesTrak `FORMAT=JSON` body: an array holding exactly one OMM for `expectedNoradId`.
 * CelesTrak answers an unknown or decayed catalogue number with a plain-text message and
 * a 200; that is a refusal here, not a crash.
 */
export function parseOmmBody(text: string, expectedNoradId: number): OmmParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }
  if (!Array.isArray(value) || value.length !== 1) {
    return { ok: false, reason: 'body is not a one-record OMM array' };
  }
  return parseOmmObject(value[0], expectedNoradId);
}

/** Back to the OMM shape `satellite.js` reads — only the fields SGP4 uses, all numeric. */
export function toOmmJson(record: OmmRecord): OMMJsonObject {
  return {
    OBJECT_NAME: record.objectName,
    OBJECT_ID: record.objectId,
    EPOCH: new Date(record.epochMs).toISOString().replace('Z', ''),
    MEAN_MOTION: record.meanMotionRevPerDay,
    ECCENTRICITY: record.eccentricity,
    INCLINATION: record.inclinationDeg,
    RA_OF_ASC_NODE: record.raOfAscNodeDeg,
    ARG_OF_PERICENTER: record.argOfPericenterDeg,
    MEAN_ANOMALY: record.meanAnomalyDeg,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: record.noradId,
    ELEMENT_SET_NO: record.elementSetNo,
    REV_AT_EPOCH: record.revAtEpoch,
    BSTAR: record.bstar,
    MEAN_MOTION_DOT: record.meanMotionDot,
    MEAN_MOTION_DDOT: record.meanMotionDdot,
  };
}

/** SGP4 initialised from a validated record ('i' — improved mode, the library default). */
export function satrecFromOmm(record: OmmRecord): SatRec {
  return json2satrec(toOmmJson(record));
}
