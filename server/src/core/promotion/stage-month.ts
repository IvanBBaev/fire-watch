/**
 * Staging one month of SP detections out of the B8 archive (ADR-002 D7 as amended by
 * A1.4, step 1; TASKS C7).
 *
 * The rows are rebuilt from the archived CSVs through the *same* pipeline the live path
 * uses — same parser, same canonical serializer minting `detection_uid`, same
 * deterministic batch order — so a staged SP row differs from a live NRT row only in
 * what the provider reprocessed, never in how we read it. There is deliberately no
 * SP↔NRT uid alignment: A1.4 step 1 rules it out as impossible, because SP shifts
 * coordinates and lat/lon are hash inputs, so the uids are different *by construction*
 * and reconciliation happens at event level (D-track), not at row level.
 *
 * Fail-closed at the edges: a month the plan does not cover, a chunk the manifest does
 * not vouch for as complete, or a vouched-for file that is missing all throw and leave
 * NRT live. Row-level parser rejections, by contrast, are counted and reported, not
 * fatal — a single unparseable row in a six-year-old archive must not permanently block
 * promotion, and a day's worth of loss is what the A1.4 coverage check exists to catch.
 * Byte integrity is `backfill-cli --check`'s job, run before promoting.
 */

import { SOURCE_REGISTRY_VERSION } from '@fire-watch/contracts';

import type { BackfillManifest } from '../backfill/backfill-manifest.js';
import { completedEntry } from '../backfill/backfill-manifest.js';
import type { BackfillChunk, BackfillJob } from '../backfill/backfill-plan.js';
import { orderBatch, assertTotalOrder } from '../determinism/batch-order.js';
import type { FirmsRow } from '../ingest/firms-csv.js';
import { parseFirmsCsv } from '../ingest/firms-csv.js';
import { epochMsFromIso } from '../ports/clock.js';
import type { DetectionRecord } from '../ports/detection-store.js';
import type { DetectionUidFn } from '../ports/firms-client.js';
import type { SpArchiveReader } from '../ports/sp-archive-reader.js';
import type { MonthWindow } from './month-window.js';

const DAY_MS = 86_400_000;

export interface StageMonthDeps {
  readonly archive: SpArchiveReader;
  readonly detectionUid: DetectionUidFn;
}

export interface StagedMonth {
  readonly window: MonthWindow;
  /** The month's SP rows, deterministically ordered, ready for the staging table. */
  readonly records: readonly DetectionRecord[];
  readonly chunksRead: number;
  readonly rowsParsed: number;
  /** Parsed rows whose acq_ts falls outside the month (chunks overlap month edges). */
  readonly rowsOutsideMonth: number;
  /** Row-level parser rejections across the month's chunks. Reported, not fatal. */
  readonly rowsRejected: number;
  /** Rows whose uid was already staged — FIRMS SP files can overlap at chunk seams. */
  readonly duplicatesWithinMonth: number;
}

/**
 * The plan chunks that overlap the month. Chunks are ≤10 UTC days anchored to the
 * plan's grid, so a month's first days usually arrive in a chunk that started in the
 * previous month — overlap, not containment, is the membership test.
 */
export function monthChunks(job: BackfillJob, window: MonthWindow): readonly BackfillChunk[] {
  return job.chunks.filter((chunk) => {
    const chunkStartMs = epochMsFromIso(`${chunk.startDate}T00:00:00Z`);
    const chunkEndMs = chunkStartMs + chunk.dayRange * DAY_MS;
    return chunkStartMs < window.endMs && chunkEndMs > window.startMs;
  });
}

type StagedIntermediate = FirmsRow & {
  readonly detectionUid: string;
  readonly availableAt: number;
};

export async function stageMonth(
  window: MonthWindow,
  job: BackfillJob,
  manifest: BackfillManifest,
  deps: StageMonthDeps,
): Promise<StagedMonth> {
  const chunks = monthChunks(job, window);
  if (chunks.length === 0) {
    throw new RangeError(`the backfill plan ${job.plan} has no chunks covering ${window.month}`);
  }

  // All-or-nothing before any parsing: a month is promoted whole, so every chunk that
  // overlaps it must be vouched for as complete before a single row is staged.
  const pairs = chunks.map((chunk) => ({ chunk, entry: completedEntry(manifest, chunk) }));
  const unvouched = pairs.filter((pair) => pair.entry === null).map((pair) => pair.chunk.chunkId);
  if (unvouched.length > 0) {
    throw new Error(
      `cannot stage ${window.month}: the manifest does not vouch for ${unvouched.join(', ')} ` +
        'as complete — finish the backfill for this month first',
    );
  }

  let rowsParsed = 0;
  let rowsOutsideMonth = 0;
  let rowsRejected = 0;
  let duplicatesWithinMonth = 0;

  const seen = new Set<string>();
  const staged: StagedIntermediate[] = [];

  for (const { chunk, entry } of pairs) {
    if (entry === null) continue; // unreachable: the unvouched guard above threw
    const text = await deps.archive.readFile(entry.path);
    if (text === null) {
      throw new Error(
        `the manifest says ${chunk.chunkId} is complete but ${entry.path} is missing from ` +
          'the archive — run backfill-cli --check and re-download before promoting',
      );
    }

    // `fetched_at` is when the archive first held these bytes — the closest honest
    // value `available_at` has for reprocessed rows that were never observed live.
    const availableAt = epochMsFromIso(entry.fetched_at);
    const parsed = parseFirmsCsv(text, { source: chunk.source });
    rowsParsed += parsed.rows.length;
    rowsRejected += parsed.rejections.length;

    for (const row of parsed.rows) {
      const acqMs = epochMsFromIso(row.acqTsIso);
      if (acqMs < window.startMs || acqMs >= window.endMs) {
        rowsOutsideMonth += 1;
        continue;
      }
      const detectionUid = deps.detectionUid({
        source: row.source,
        acqTsIso: row.acqTsIso,
        lat: row.latCanonical,
        lon: row.lonCanonical,
      });
      if (seen.has(detectionUid)) {
        duplicatesWithinMonth += 1;
        continue;
      }
      seen.add(detectionUid);
      staged.push({ ...row, detectionUid, availableAt });
    }
  }

  const ordered = orderBatch(staged);
  assertTotalOrder(ordered);

  return {
    window,
    records: ordered.map((row) => toSpRecord(row, job)),
    chunksRead: chunks.length,
    rowsParsed,
    rowsOutsideMonth,
    rowsRejected,
    duplicatesWithinMonth,
  };
}

/** The same field mapping as the live path's `detectionRecords`, with the SP tier fixed. */
function toSpRecord(row: StagedIntermediate, job: BackfillJob): DetectionRecord {
  return {
    detectionUid: row.detectionUid,
    source: row.source,
    productTier: 'SP',
    acqTsIso: row.acqTsIso,
    availableAt: row.availableAt,
    lat: row.latCanonical,
    lon: row.lonCanonical,
    scanKm: row.scanKm,
    trackKm: row.trackKm,
    frpMw: row.frpMw,
    brightnessK: row.brightnessK,
    brightnessBgK: row.brightnessSecondaryK,
    confidenceRaw: row.confidenceRaw,
    confidence: row.confidence,
    dayNight: row.dayNight,
    collectionVersion: row.versionRaw === '' ? null : row.versionRaw,
    sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
    ingestConfigVersion: job.pollingBboxVersion,
    quarantined: false,
  };
}
