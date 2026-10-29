/**
 * The FireSat detection document, read into the detection model (V3-A1).
 *
 * ## The format is provisional, and says so
 *
 * Earth Fire Alliance has published no delivery format, no API and no redistribution terms
 * (V3-Q5; DATA-SOURCES §A6). This parser is built **fixtures first** so the mapping is
 * written, reviewed and tested before access day, and the shape it reads is ours:
 * `firesat-detections` at `format_version` {@link FIRESAT_FORMAT_VERSION}. Every field below
 * is one FireSat has publicly described (six bands incl. 2 × MWIR and LWIR, per-detection
 * pixel footprint, a detection probability rather than a class, ~80 m average GSD). When the
 * real format arrives, this file and its fixtures change; the rows it produces do not,
 * because they are the same {@link FirmsRow} the FIRMS path produces and everything after
 * the parser is source-blind.
 *
 * A document that does not declare this format and version is refused whole: reading an
 * unknown format "as best we can" would put guessed values into an append-only archive.
 *
 * ## Mapping
 *
 *   * **Source.** Every row is `efa:firesat`, from the registry — never from the document's
 *     `satellite` field, which is kept for audit only (the FIRMS pitfall 5 rule). The
 *     constellation is one source id (GLOSSARY §1a rule 2: one product, one id).
 *   * **Acquisition time.** An ISO instant; truncated to the UTC minute by the one shared
 *     rule (`canonicalAcqTsIsoFromInstant`), exactly as every other source's `acq_ts` is.
 *   * **Coordinates.** Decimal text or a JSON number; canonicalised to 5 dp by the shared
 *     rule, which is also the range check.
 *   * **Footprint.** `pixel_along_scan_m` / `pixel_along_track_m`, required and positive:
 *     per-detection ε is computed from the footprint (FIRMS pitfall 8), and a missing one
 *     would silently fall back to a swath-centre assumption. Stored in km like FIRMS'
 *     `scan` / `track`.
 *   * **Confidence.** `detection_probability` in [0, 1], normalised by
 *     {@link FIRESAT_CONFIDENCE}; the delivered text is kept verbatim in `confidenceRaw`.
 *   * **FRP.** `null` is "not reported", `0` is a reported zero (FIRMS pitfall 9).
 *   * **Brightness.** MWIR → `brightnessK`, LWIR → `brightnessSecondaryK` (the same
 *     roles VIIRS I4 / I5 play).
 *
 * The parser is total like the FIRMS CSV parser: a detection it cannot canonicalise is a
 * rejection carrying its bytes, never dropped and never coerced. A JSON document has no
 * "line as delivered", so a rejection's `raw` is the element re-serialised canonically —
 * the closest stable form of what arrived.
 */

import {
  SOURCE_REGISTRY,
  canonicalAcqTsIsoFromInstant,
  canonicalDegrees,
  detectionUidPreimage,
  type SourceId,
} from '@fire-watch/contracts';

import { defineConfig, type VersionedConfig } from '../../core/config/versioned-config.js';
import { canonicalJson } from '../../core/determinism/canonical-json.js';
import type {
  DayNight,
  FirmsCsvResult,
  FirmsRow,
  FirmsRowRejection,
  NormalizedConfidence,
} from '../../core/ingest/firms-csv.js';

/** The one source id every FireSat row is attributed to. */
export const FIRESAT_SOURCE = 'efa:firesat' satisfies SourceId;

export const FIRESAT_FORMAT = 'firesat-detections';

/** Our provisional shape; bumped (and the fixtures regenerated) when EFA publishes theirs. */
export const FIRESAT_FORMAT_VERSION = '0-provisional';

export interface FiresatConfidenceParams {
  /** `detection_probability` at or above this is `nominal`. */
  readonly nominalFrom: number;
  /** `detection_probability` at or above this is `high`. */
  readonly highFrom: number;
}

/**
 * `firesat_confidence_v0` — the probability → class cut points.
 *
 * **Unfitted, and borrowed rather than invented.** These are the FIRMS cut points for the
 * other probability-shaped scale we already read (MODIS 0–100: < 30 low, < 80 nominal,
 * else high), rescaled to [0, 1]. EFA's claimed < 5 % false-positive rate is a property of
 * its own threshold, not of these classes; the first season of FireSat rows against VIIRS
 * is what replaces them (a `_v1` with a fit behind it, as D7 did for the other params).
 */
export const FIRESAT_CONFIDENCE: VersionedConfig<FiresatConfidenceParams> = defineConfig(
  'firesat_confidence',
  'firesat_confidence_v0',
  { nominalFrom: 0.3, highFrom: 0.8 },
);

export function firesatConfidence(
  probability: number,
  params: FiresatConfidenceParams = FIRESAT_CONFIDENCE.values,
): NormalizedConfidence {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError(
      `detection_probability must be a number in [0, 1], got ${JSON.stringify(probability)}`,
    );
  }
  if (probability < params.nominalFrom) return 'low';
  if (probability < params.highFrom) return 'nominal';
  return 'high';
}

/** A response that is not a FireSat detection document of the version we read. */
export class FiresatFormatError extends Error {
  override readonly name = 'FiresatFormatError';
}

export function parseFiresatDocument(text: string): FirmsCsvResult {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new FiresatFormatError(
      `FireSat response is not JSON. First 120 bytes: ${JSON.stringify(text.slice(0, 120))}`,
    );
  }
  if (!isRecord(document)) {
    throw new FiresatFormatError('FireSat response is not a JSON object');
  }
  if (document['format'] !== FIRESAT_FORMAT) {
    throw new FiresatFormatError(
      `FireSat response format is ${JSON.stringify(document['format'])}, expected ` +
        JSON.stringify(FIRESAT_FORMAT),
    );
  }
  if (document['format_version'] !== FIRESAT_FORMAT_VERSION) {
    throw new FiresatFormatError(
      `FireSat format_version ${JSON.stringify(document['format_version'])} is not the ` +
        `one this parser reads (${FIRESAT_FORMAT_VERSION})`,
    );
  }
  const product = SOURCE_REGISTRY[FIRESAT_SOURCE].queriedProduct;
  if (document['product'] !== product) {
    throw new FiresatFormatError(
      `FireSat product is ${JSON.stringify(document['product'])}, expected ${product}`,
    );
  }
  const detections = document['detections'];
  if (!Array.isArray(detections)) {
    throw new FiresatFormatError('FireSat response has no `detections` array');
  }

  const rows: FirmsRow[] = [];
  const rejections: FirmsRowRejection[] = [];
  detections.forEach((element: unknown, position) => {
    const rowIndex = position + 1;
    const raw = canonicalJson(element);
    try {
      rows.push(readDetection(rowIndex, raw, element));
    } catch (error) {
      rejections.push({
        rowIndex,
        reason: error instanceof Error ? error.message : String(error),
        raw,
      });
    }
  });

  return { source: FIRESAT_SOURCE, header: [...FIELDS], rows, rejections };
}

/** The fields a detection may carry, in document order; the result's `header`. */
const FIELDS = [
  'satellite',
  'acquired_at',
  'latitude',
  'longitude',
  'pixel_along_scan_m',
  'pixel_along_track_m',
  'detection_probability',
  'frp_mw',
  'brightness_mwir_k',
  'brightness_lwir_k',
  'day_night',
  'processing_version',
] as const;

function readDetection(rowIndex: number, raw: string, element: unknown): FirmsRow {
  if (!isRecord(element)) {
    throw new RangeError('detection must be a JSON object');
  }
  const acqTsIso = canonicalAcqTsIsoFromInstant(requiredString(element, 'acquired_at'));
  const latCanonical = canonicalDegrees(requiredCoordinate(element, 'latitude'));
  const lonCanonical = canonicalDegrees(requiredCoordinate(element, 'longitude'));
  const uidPreimage = detectionUidPreimage({
    source: FIRESAT_SOURCE,
    acqTsIso,
    lat: latCanonical,
    lon: lonCanonical,
  });

  const probability = element['detection_probability'];
  if (typeof probability !== 'number') {
    throw new RangeError(
      `detection_probability must be a number, got ${JSON.stringify(probability)}`,
    );
  }

  return {
    rowIndex,
    raw,
    source: FIRESAT_SOURCE,
    acqTsIso,
    latCanonical,
    lonCanonical,
    uidPreimage,
    confidence: firesatConfidence(probability),
    confidenceRaw: String(probability),
    frpMw: optionalNumber(element, 'frp_mw'),
    dayNight: readDayNight(element['day_night']),
    scanKm: requiredPixelKm(element, 'pixel_along_scan_m'),
    trackKm: requiredPixelKm(element, 'pixel_along_track_m'),
    brightnessK: optionalNumber(element, 'brightness_mwir_k'),
    brightnessSecondaryK: optionalNumber(element, 'brightness_lwir_k'),
    satelliteRaw: optionalString(element, 'satellite'),
    instrumentRaw: 'FireSat',
    versionRaw: optionalString(element, 'processing_version'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(element: Record<string, unknown>, field: string): string {
  const value = element[field];
  if (typeof value !== 'string' || value === '') {
    throw new RangeError(`${field} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalString(element: Record<string, unknown>, field: string): string {
  const value = element[field];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new RangeError(`${field} must be a string or absent, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requiredCoordinate(element: Record<string, unknown>, field: string): string | number {
  const value = element[field];
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }
  throw new RangeError(`${field} must be a decimal string or number, got ${JSON.stringify(value)}`);
}

/** Absent or `null` is "not reported"; anything else must be a finite number. */
function optionalNumber(element: Record<string, unknown>, field: string): number | null {
  const value = element[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${field} must be a finite number or null, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Metres in, kilometres out; required and positive (FIRMS pitfall 8). */
function requiredPixelKm(element: Record<string, unknown>, field: string): number {
  const value = element[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `${field} must be a positive number of metres, got ${JSON.stringify(value)}`,
    );
  }
  return value / 1000;
}

function readDayNight(value: unknown): DayNight {
  if (value === undefined || value === null) return null;
  if (value === 'D' || value === 'N') return value;
  throw new RangeError(`day_night must be D, N or null, got ${JSON.stringify(value)}`);
}
