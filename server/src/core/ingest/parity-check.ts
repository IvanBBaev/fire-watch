/**
 * The ingestion-parity check — what we stored vs what FIRMS publishes (TASKS C9; A23:
 * "ingestion-parity monitor vs the FIRMS map in week one"; 06 §5.5).
 *
 * The reference is a CSV exported from FIRMS for one product over the same window — the
 * FIRMS map's download or an area-API response, which share the column set and so the
 * parser (`firms-csv.ts`). Our side is the NRT rows in `detections`. The comparison is
 * per source and returns one canonical report: the bytes a reviewer signs, identical on a
 * re-run over the same inputs.
 *
 * ## The rules, each stated so it cannot drift
 *
 *   - **Identity is `detection_uid`.** A reference row is hashed exactly as the poller
 *     hashes (the injected `DetectionUidFn`, GLOSSARY §1b), so equal uids are the same
 *     detection and nothing else is.
 *   - **The window is on `acq_ts`**, half-open `[from, to)`, on both sides. A reference
 *     row outside it is counted in `outOfWindow` and compared with nothing — a map export
 *     rarely ends on the same minute as the window.
 *   - **The area is `POLLING_BBOX`**, inclusive, on both sides. A map export drawn wider
 *     than the bbox would otherwise be a wall of "missing" rows we never asked for.
 *   - **Missing fails; extra does not.** 06 §5.5 alarms on "any deficit > 0". A row we
 *     hold that the reference lacks is reported — FIRMS re-processes and drops rows, and
 *     the append-only archive keeps what it saw — but it is not a deficit.
 *   - **Near matches are off** unless `parity_check_v1` says otherwise (it does not; see
 *     `parity-params.ts`). When both tolerances are set, each missing row is paired
 *     greedily, deterministically, with at most one unclaimed extra row of the same source
 *     inside them; the pairs are reported separately and leave the deficit.
 *   - **Quarantined rows of ours count as ingested**, and are counted beside it: a
 *     quarantine is a verdict on content, not a failure to ingest.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { BoundingBox } from '../config/polling-bbox.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import { epochMsFromIso, isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { DetectionUidFn } from '../ports/firms-client.js';
import type { FirmsCsvResult } from './firms-csv.js';
import type { ParityCheckParams } from './parity-params.js';

const MS_PER_MINUTE = 60_000;

export interface ParityWindow {
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
}

/** One detection on either side, reduced to what identity and near-matching need. */
export interface ParityRow {
  readonly detectionUid: string;
  readonly source: SourceId;
  readonly acqTsMs: EpochMs;
  readonly lat: number;
  readonly lon: number;
}

export interface OurParityRow extends ParityRow {
  readonly quarantined: boolean;
}

/** One source's reference file, parsed and hashed. */
export interface ParityReference {
  readonly source: SourceId;
  readonly rows: readonly ParityRow[];
  /** Rows the CSV parser rejected — each is a reference row we could not compare. */
  readonly rejected: number;
}

export interface NearMatch {
  readonly referenceUid: string;
  readonly ourUid: string;
  readonly acqDeltaMs: number;
  readonly latDelta: number;
  readonly lonDelta: number;
}

export interface SourceParity {
  readonly source: SourceId;
  readonly reference: {
    /** Compared rows: in the window, in the bbox, deduplicated. */
    readonly rows: number;
    readonly rejected: number;
    readonly duplicates: number;
    readonly outOfWindow: number;
    readonly outsideBbox: number;
    readonly maxAcqTs: string | null;
  };
  readonly ours: {
    readonly rows: number;
    readonly quarantined: number;
    readonly outOfWindow: number;
    readonly outsideBbox: number;
    readonly maxAcqTs: string | null;
  };
  readonly matched: number;
  readonly nearMatched: number;
  readonly missing: number;
  readonly extra: number;
  /** Sorted. Reference rows with no counterpart — the deficit. */
  readonly missingUids: readonly string[];
  /** Sorted. Rows of ours the reference lacks. */
  readonly extraUids: readonly string[];
  readonly nearMatches: readonly NearMatch[];
}

export type ParityVerdict = 'parity' | 'deficit';

export interface ParityReport {
  readonly configVersion: string;
  readonly configDigest: string;
  readonly bboxVersion: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly sources: readonly SourceParity[];
  /** `deficit` when any source has a missing row after near-matching. */
  readonly verdict: ParityVerdict;
}

/**
 * A parsed reference CSV → the rows the comparator reads. Rejections are counted, not
 * dropped silently; a row the uid function refuses throws, because the parser has already
 * canonicalized every field it hashes and a refusal there is a bug, not data.
 */
export function referenceFromCsv(
  parsed: FirmsCsvResult,
  detectionUid: DetectionUidFn,
): ParityReference {
  return {
    source: parsed.source,
    rejected: parsed.rejections.length,
    rows: parsed.rows.map((row) => ({
      detectionUid: detectionUid({
        source: row.source,
        acqTsIso: row.acqTsIso,
        lat: row.latCanonical,
        lon: row.lonCanonical,
      }),
      source: row.source,
      acqTsMs: epochMsFromIso(row.acqTsIso),
      lat: Number(row.latCanonical),
      lon: Number(row.lonCanonical),
    })),
  };
}

export interface ParityInput {
  readonly window: ParityWindow;
  /** One entry per source compared; a source appears at most once. */
  readonly references: readonly ParityReference[];
  /** Our NRT rows. Rows of a source with no reference are ignored. */
  readonly ours: readonly OurParityRow[];
  readonly bbox: VersionedConfig<BoundingBox>;
  readonly config: VersionedConfig<ParityCheckParams>;
}

export function parityCheck(input: ParityInput): ParityReport {
  const tolerance = nearMatchTolerance(input.config.values);
  const seenSources = new Set<SourceId>();
  for (const reference of input.references) {
    if (seenSources.has(reference.source)) {
      throw new RangeError(`reference for ${reference.source} given more than once`);
    }
    seenSources.add(reference.source);
  }

  const sources = [...input.references]
    .sort((a, b) => compareText(a.source, b.source))
    .map((reference) =>
      sourceParity(
        reference,
        input.ours.filter((row) => row.source === reference.source),
        input.window,
        input.bbox.values,
        tolerance,
      ),
    );

  return {
    configVersion: input.config.version,
    configDigest: input.config.digest,
    bboxVersion: input.bbox.version,
    window: { from: isoFromEpochMs(input.window.fromMs), to: isoFromEpochMs(input.window.toMs) },
    sources,
    verdict: sources.some((source) => source.missing > 0) ? 'deficit' : 'parity',
  };
}

export function renderParityReport(report: ParityReport): string {
  return canonicalJson(report);
}

interface Tolerance {
  readonly acqMs: number;
  readonly deg: number;
}

function nearMatchTolerance(params: ParityCheckParams): Tolerance | null {
  const { acqToleranceMinutes, coordToleranceDeg } = params.nearMatch;
  if (acqToleranceMinutes === null && coordToleranceDeg === null) return null;
  if (acqToleranceMinutes === null || coordToleranceDeg === null) {
    throw new RangeError('parity near-match tolerances must both be null or both be set');
  }
  if (!(acqToleranceMinutes >= 0) || !(coordToleranceDeg >= 0)) {
    throw new RangeError('parity near-match tolerances must be non-negative');
  }
  return { acqMs: acqToleranceMinutes * MS_PER_MINUTE, deg: coordToleranceDeg };
}

function sourceParity(
  reference: ParityReference,
  ourRows: readonly OurParityRow[],
  window: ParityWindow,
  bbox: BoundingBox,
  tolerance: Tolerance | null,
): SourceParity {
  const refSide = partition(reference.rows, window, bbox);
  const ourSide = partition(ourRows, window, bbox);

  const matchedUids = [...refSide.byUid.keys()].filter((uid) => ourSide.byUid.has(uid));
  const missingRows = [...refSide.byUid.values()].filter(
    (row) => !ourSide.byUid.has(row.detectionUid),
  );
  const extraRows = [...ourSide.byUid.values()].filter(
    (row) => !refSide.byUid.has(row.detectionUid),
  );

  const nearMatches = tolerance === null ? [] : pairNear(missingRows, extraRows, tolerance);
  const pairedRef = new Set(nearMatches.map((pair) => pair.referenceUid));
  const pairedOurs = new Set(nearMatches.map((pair) => pair.ourUid));
  const missingUids = missingRows
    .map((row) => row.detectionUid)
    .filter((uid) => !pairedRef.has(uid))
    .sort(compareText);
  const extraUids = extraRows
    .map((row) => row.detectionUid)
    .filter((uid) => !pairedOurs.has(uid))
    .sort(compareText);

  return {
    source: reference.source,
    reference: {
      rows: refSide.byUid.size,
      rejected: reference.rejected,
      duplicates: refSide.duplicates,
      outOfWindow: refSide.outOfWindow,
      outsideBbox: refSide.outsideBbox,
      maxAcqTs: maxAcqTs(refSide.byUid.values()),
    },
    ours: {
      rows: ourSide.byUid.size,
      quarantined: [...ourSide.byUid.values()].filter((row) => row.quarantined).length,
      outOfWindow: ourSide.outOfWindow,
      outsideBbox: ourSide.outsideBbox,
      maxAcqTs: maxAcqTs(ourSide.byUid.values()),
    },
    matched: matchedUids.length,
    nearMatched: nearMatches.length,
    missing: missingUids.length,
    extra: extraUids.length,
    missingUids,
    extraUids,
    nearMatches,
  };
}

interface Side<T extends ParityRow> {
  readonly byUid: Map<string, T>;
  readonly duplicates: number;
  readonly outOfWindow: number;
  readonly outsideBbox: number;
}

function partition<T extends ParityRow>(
  rows: readonly T[],
  window: ParityWindow,
  bbox: BoundingBox,
): Side<T> {
  const byUid = new Map<string, T>();
  let duplicates = 0;
  let outOfWindow = 0;
  let outsideBbox = 0;
  for (const row of rows) {
    if (row.acqTsMs < window.fromMs || row.acqTsMs >= window.toMs) {
      outOfWindow += 1;
    } else if (
      row.lat < bbox.south ||
      row.lat > bbox.north ||
      row.lon < bbox.west ||
      row.lon > bbox.east
    ) {
      outsideBbox += 1;
    } else if (byUid.has(row.detectionUid)) {
      duplicates += 1;
    } else {
      byUid.set(row.detectionUid, row);
    }
  }
  return { byUid, duplicates, outOfWindow, outsideBbox };
}

/**
 * Greedy and order-independent: missing rows in (acq_ts, uid) order, each taking the
 * closest unclaimed extra row inside both tolerances — closest by acquisition delta, then
 * by the larger coordinate delta, then by uid. The same inputs give the same pairs in any
 * input order.
 */
function pairNear(
  missing: readonly ParityRow[],
  extra: readonly ParityRow[],
  tolerance: Tolerance,
): NearMatch[] {
  const claimed = new Set<string>();
  const pairs: NearMatch[] = [];
  for (const ref of [...missing].sort(byAcqThenUid)) {
    let best: { row: ParityRow; acq: number; coord: number } | null = null;
    for (const ours of extra) {
      if (claimed.has(ours.detectionUid)) continue;
      const acq = Math.abs(ours.acqTsMs - ref.acqTsMs);
      const coord = Math.max(Math.abs(ours.lat - ref.lat), Math.abs(ours.lon - ref.lon));
      if (acq > tolerance.acqMs || coord > tolerance.deg) continue;
      if (
        best === null ||
        acq < best.acq ||
        (acq === best.acq && coord < best.coord) ||
        (acq === best.acq &&
          coord === best.coord &&
          compareText(ours.detectionUid, best.row.detectionUid) < 0)
      ) {
        best = { row: ours, acq, coord };
      }
    }
    if (best === null) continue;
    claimed.add(best.row.detectionUid);
    pairs.push({
      referenceUid: ref.detectionUid,
      ourUid: best.row.detectionUid,
      acqDeltaMs: best.row.acqTsMs - ref.acqTsMs,
      latDelta: roundDegrees(best.row.lat - ref.lat),
      lonDelta: roundDegrees(best.row.lon - ref.lon),
    });
  }
  return pairs;
}

/** Coordinates are 5-dp on both sides; the difference is too, once float noise is gone. */
function roundDegrees(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function maxAcqTs(rows: Iterable<ParityRow>): string | null {
  let max: number | null = null;
  for (const row of rows) if (max === null || row.acqTsMs > max) max = row.acqTsMs;
  return max === null ? null : isoFromEpochMs(max);
}

function byAcqThenUid(a: ParityRow, b: ParityRow): number {
  return a.acqTsMs - b.acqTsMs || compareText(a.detectionUid, b.detectionUid);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
