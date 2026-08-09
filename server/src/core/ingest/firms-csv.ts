/**
 * The FIRMS CSV parser (DATA-SOURCES §A1.1).
 *
 * Every rule here is one row of the pitfall table — bugs that have bitten real pipelines
 * and that we get exactly one season to avoid, because a season cannot be re-run:
 *
 *   1 `acq_time` is `HHMM` with no leading-zero guarantee, so `"142"` is 01:42 UTC.
 *   4 MODIS and VIIRS carry different columns and a different confidence scale.
 *   5 The `satellite` column is inconsistent across products and vintages, so the source
 *     is derived from the *queried* product and the column is kept for audit only.
 *   7 VIIRS `low` is often sun glint; it stays parseable but is gated downstream.
 *   8 `scan`/`track` are the pixel footprint and drive per-detection ε — never dropped.
 *   9 FRP is occasionally null or zero; zero is a measurement, empty is not.
 *
 * The parser is total: a row it cannot canonicalize is returned as a rejection carrying
 * its raw bytes, never thrown away and never silently coerced. Whole-file problems (a
 * missing column, an error page served with a 200) throw, because those are not one bad
 * row — they mean this response is not the thing we asked for.
 */

import {
  SOURCE_REGISTRY,
  canonicalAcqTsIso,
  canonicalDegrees,
  detectionUidPreimage,
  type SourceId,
} from '@fire-watch/contracts';

/** The normalized three-valued scale; `confidenceRaw` always keeps what arrived. */
export type NormalizedConfidence = 'low' | 'nominal' | 'high';

export type DayNight = 'D' | 'N' | null;

export interface FirmsRow {
  /** 1-based index among data rows, so a rejection and a row address the same line. */
  readonly rowIndex: number;
  /**
   * The line as delivered. A row can parse cleanly and still fail E1 validation (C2) — a
   * coordinate outside the polled box, an acquisition stamped after we received it — and
   * at that point the bytes are the only honest evidence of what arrived. Re-serializing
   * the parsed fields would quarantine our reading of the row rather than the row.
   */
  readonly raw: string;
  /** The §1a canonical id, from the queried product — never from the CSV (pitfall 5). */
  readonly source: SourceId;
  /** `YYYY-MM-DDTHH:MM:00Z`, exactly 20 characters (GLOSSARY §1b). */
  readonly acqTsIso: string;
  readonly latCanonical: string;
  readonly lonCanonical: string;
  /**
   * The exact bytes `detection_uid` hashes (GLOSSARY §1b). Carried rather than recomputed
   * so that a row which left the parser is, by construction, a row that can be hashed —
   * a range violation surfaces in the rejection channel here instead of throwing in the
   * adapter, past the point where the raw bytes are still available to quarantine.
   */
  readonly uidPreimage: string;
  readonly confidence: NormalizedConfidence;
  /** Verbatim, because the normalization is a UX and alert-gating device, not a fact. */
  readonly confidenceRaw: string;
  /** Megawatts. `null` is "not reported"; `0` is a reported zero (pitfall 9). */
  readonly frpMw: number | null;
  readonly dayNight: DayNight;
  /** Pixel footprint in km along-scan / along-track — per-detection ε (pitfall 8). */
  readonly scanKm: number | null;
  readonly trackKm: number | null;
  /** `bright_ti4` (VIIRS) or `brightness` (MODIS), kelvin. */
  readonly brightnessK: number | null;
  /** `bright_ti5` (VIIRS) or `bright_t31` (MODIS), kelvin. */
  readonly brightnessSecondaryK: number | null;
  /** Audit-only provenance. Never used to decide which satellite this was. */
  readonly satelliteRaw: string;
  readonly instrumentRaw: string;
  /** Product version, e.g. `2.0NRT` — the NRT/SP tier marker (pitfall 6). */
  readonly versionRaw: string;
}

export interface FirmsRowRejection {
  readonly rowIndex: number;
  readonly reason: string;
  /** The line as delivered. C2 quarantines these bytes; a re-serialized row would lie. */
  readonly raw: string;
}

export interface FirmsCsvResult {
  readonly source: SourceId;
  readonly header: readonly string[];
  readonly rows: readonly FirmsRow[];
  readonly rejections: readonly FirmsRowRejection[];
}

/** A response that is not a FIRMS CSV at all — a wrong key, an outage page, an HTML error. */
export class FirmsCsvFormatError extends Error {
  override readonly name = 'FirmsCsvFormatError';
}

type ProductFamily = 'viirs' | 'modis';

/**
 * Which parser a source needs. Derived from the frozen registry's `queriedProduct`, so
 * adding a source to the registry cannot silently land it in the wrong family.
 */
function productFamily(source: SourceId): ProductFamily {
  const product = SOURCE_REGISTRY[source].queriedProduct;
  if (product.startsWith('VIIRS_')) return 'viirs';
  if (product.startsWith('MODIS_')) return 'modis';
  throw new RangeError(
    `${source} (${product}) is not a FIRMS product; the FIRMS CSV parser does not apply`,
  );
}

const COLUMNS = {
  viirs: { brightness: 'bright_ti4', brightnessSecondary: 'bright_ti5' },
  modis: { brightness: 'brightness', brightnessSecondary: 'bright_t31' },
} as const;

/**
 * Columns whose absence makes the response unusable rather than merely thinner.
 * `scan`/`track` are in here because per-detection ε is computed from the footprint and
 * a missing footprint would silently fall back to a swath-centre assumption; `daynight`
 * is in here because the night overpasses carry the highest miss-evidence weight.
 * `satellite`, `instrument` and `version` are captured when present but never required —
 * they are audit columns, and pitfall 5 already forbids deciding anything from them.
 */
const REQUIRED_COLUMNS = [
  'latitude',
  'longitude',
  'acq_date',
  'acq_time',
  'confidence',
  'frp',
  'scan',
  'track',
  'daynight',
] as const;

/**
 * VIIRS confidence as a literal table rather than a case fold. Nothing here depends on
 * `toLowerCase`, so nothing here can behave differently under a Turkish locale — which
 * is exactly the class of difference gate CI-2 exists to catch.
 */
const VIIRS_CONFIDENCE: Readonly<Record<string, NormalizedConfidence>> = {
  l: 'low',
  L: 'low',
  n: 'nominal',
  N: 'nominal',
  h: 'high',
  H: 'high',
};

/** The FIRMS convention for MODIS' 0–100 scale (DATA-SOURCES §A1.1). */
function modisConfidence(percent: number): NormalizedConfidence {
  if (percent < 30) return 'low';
  if (percent < 80) return 'nominal';
  return 'high';
}

export interface ParseFirmsCsvOptions {
  /** The source we asked for. Everything about platform attribution follows from this. */
  readonly source: SourceId;
}

export function parseFirmsCsv(text: string, options: ParseFirmsCsvOptions): FirmsCsvResult {
  const family = productFamily(options.source);
  const lines = splitLines(text);
  const headerLine = lines[0];
  if (headerLine === undefined) {
    throw new FirmsCsvFormatError('FIRMS response was empty; expected at least a header row');
  }

  const header = parseCsvLine(headerLine).map((cell) => cell.trim());
  const index = new Map<string, number>();
  header.forEach((name, position) => {
    if (!index.has(name)) index.set(name, position);
  });

  const columns = COLUMNS[family];
  const missing = [...REQUIRED_COLUMNS, columns.brightness, columns.brightnessSecondary].filter(
    (name) => !index.has(name),
  );
  if (missing.length > 0) {
    throw new FirmsCsvFormatError(
      `FIRMS response is not a ${family.toUpperCase()} CSV: missing column(s) ` +
        `${missing.join(', ')}. First 120 bytes: ${JSON.stringify(text.slice(0, 120))}`,
    );
  }

  const rows: FirmsRow[] = [];
  const rejections: FirmsRowRejection[] = [];

  for (let line = 1; line < lines.length; line += 1) {
    const raw = lines[line] as string;
    if (raw.trim() === '') continue;
    const rowIndex = rows.length + rejections.length + 1;
    const cells = parseCsvLine(raw);
    const at = (name: string): string => {
      const position = index.get(name);
      return position === undefined ? '' : (cells[position] ?? '').trim();
    };

    try {
      rows.push(readRow(rowIndex, raw, at, options.source, family, columns));
    } catch (error) {
      rejections.push({
        rowIndex,
        reason: error instanceof Error ? error.message : String(error),
        raw,
      });
    }
  }

  return { source: options.source, header, rows, rejections };
}

function readRow(
  rowIndex: number,
  raw: string,
  at: (name: string) => string,
  source: SourceId,
  family: ProductFamily,
  columns: (typeof COLUMNS)[ProductFamily],
): FirmsRow {
  // Pitfall 1 lives inside `canonicalAcqTsIso`: it pads `HHMM` and refuses anything that
  // is not a UTC minute. There is one implementation of that rule and this is not it.
  const acqTsIso = canonicalAcqTsIso(at('acq_date'), at('acq_time'));
  const latCanonical = canonicalDegrees(at('latitude'));
  const lonCanonical = canonicalDegrees(at('longitude'));

  // Also the range check: `canonicalDegrees` normalizes the text, `detectionUidPreimage`
  // is what refuses a latitude of 91. One definition of "hashable", not two.
  const uidPreimage = detectionUidPreimage({
    source,
    acqTsIso,
    lat: latCanonical,
    lon: lonCanonical,
  });

  const confidenceRaw = at('confidence');
  return {
    rowIndex,
    raw,
    source,
    acqTsIso,
    latCanonical,
    lonCanonical,
    uidPreimage,
    confidence: normalizeConfidence(confidenceRaw, family),
    confidenceRaw,
    frpMw: optionalNumber(at('frp'), 'frp'),
    dayNight: readDayNight(at('daynight')),
    scanKm: optionalNumber(at('scan'), 'scan'),
    trackKm: optionalNumber(at('track'), 'track'),
    brightnessK: optionalNumber(at(columns.brightness), columns.brightness),
    brightnessSecondaryK: optionalNumber(
      at(columns.brightnessSecondary),
      columns.brightnessSecondary,
    ),
    satelliteRaw: at('satellite'),
    instrumentRaw: at('instrument'),
    versionRaw: at('version'),
  };
}

function normalizeConfidence(raw: string, family: ProductFamily): NormalizedConfidence {
  if (family === 'viirs') {
    const normalized = VIIRS_CONFIDENCE[raw];
    if (normalized === undefined) {
      throw new RangeError(
        `VIIRS confidence must be l, n or h, got ${JSON.stringify(raw)}; a numeric value ` +
          'here means a MODIS file is being read with the VIIRS parser (pitfall 4)',
      );
    }
    return normalized;
  }
  if (!/^\d{1,3}$/.test(raw)) {
    throw new RangeError(
      `MODIS confidence must be an integer 0–100, got ${JSON.stringify(raw)}; a categorical ` +
        'value here means a VIIRS file is being read with the MODIS parser (pitfall 4)',
    );
  }
  const percent = Number(raw);
  if (percent > 100) {
    throw new RangeError(`MODIS confidence out of range: ${raw}`);
  }
  return modisConfidence(percent);
}

/**
 * Empty is `null`; anything else must be a finite number. `Number('')` is 0 and
 * `Number(' ')` is 0, which is how an unreported FRP becomes a reported zero and how a
 * NaN footprint reaches the ε formula — so the empty case is decided before the parse,
 * and the result is checked afterwards.
 */
function optionalNumber(raw: string, column: string): number | null {
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new RangeError(`${column} must be empty or a finite number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readDayNight(raw: string): DayNight {
  if (raw === '') return null;
  if (raw === 'D' || raw === 'N') return raw;
  throw new RangeError(`daynight must be D, N or empty, got ${JSON.stringify(raw)}`);
}

/** Splits on CRLF or LF and strips a UTF-8 BOM; the last line may or may not be terminated. */
function splitLines(text: string): readonly string[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.split(/\r\n|\n|\r/);
}

/**
 * RFC 4180 enough for this feed: quoted fields, doubled quotes inside them, commas and
 * newlines are not expected inside a value but quoting is honoured anyway. FIRMS has
 * shipped quoted columns before and a positional split would silently shift every field
 * after the quoted one.
 */
export function parseCsvLine(line: string): readonly string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}
