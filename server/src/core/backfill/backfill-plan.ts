/**
 * The FIRMS 2020–2025 SP backfill plan as versioned data (TASKS B8; IP WP0 week 1).
 *
 * The plan is config-as-data for the same reason the polling bbox is (DATA-SOURCES §A9):
 * the downloaded corpus is the input to the D7 parameter fit, and a fit that cannot cite
 * exactly which sources, area and windows it ran over is a fit nobody can reproduce. The
 * manifest records the plan version and digest, and a restart refuses to resume into an
 * archive downloaded under a different plan — mixing windows silently would bias every
 * metric computed across the seam.
 *
 * SP, not NRT: standard processing is the reprocessed archive tier (DATA-SOURCES §A1.1
 * pitfall 6) — coordinates and confidence differ from what NRT showed at the time, which
 * is exactly why the fit runs on SP and why `product_tier` is part of identity.
 */

import type { SourceId } from '@fire-watch/contracts';

import { POLLING_BBOX, firmsAreaArgument } from '../config/polling-bbox.js';
import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';
import type { FirmsAreaQuery } from '../ports/firms-client.js';

/**
 * The FIRMS archive Area API serves at most 10 calendar days per request — the same
 * `day_range` 1..10 bound the adapter's URL builder enforces.
 */
export const MAX_ARCHIVE_DAY_RANGE = 10;

export interface BackfillSourceSpec {
  /** The §1a canonical source the rows will be attributed to. */
  readonly source: SourceId;
  /** The SP product the archive API is asked for — not the registry's live NRT product. */
  readonly product: string;
  /** First acquisition day, `YYYY-MM-DD`, inclusive. */
  readonly firstDay: string;
  /** Last acquisition day, `YYYY-MM-DD`, inclusive. */
  readonly lastDay: string;
}

/**
 * NOAA-21 is deliberately absent: FIRMS serves it as NRT only (no SP product as of the
 * v1 freeze), and its record starts in 2023 anyway. When a NOAA-21 SP product appears,
 * it is *appended* here under a new plan version — specs are never edited in place,
 * because the manifest pins the digest of what was actually downloaded.
 */
export const BACKFILL_PLAN: VersionedConfig<{
  readonly sources: readonly BackfillSourceSpec[];
}> = defineConfig('firms_sp_backfill', 'firms_sp_backfill_2020_2025_v1', {
  sources: [
    {
      source: 'firms:modis',
      product: 'MODIS_SP',
      firstDay: '2020-01-01',
      lastDay: '2025-12-31',
    },
    {
      source: 'firms:viirs:snpp',
      product: 'VIIRS_SNPP_SP',
      firstDay: '2020-01-01',
      lastDay: '2025-12-31',
    },
    {
      source: 'firms:viirs:noaa20',
      product: 'VIIRS_NOAA20_SP',
      firstDay: '2020-01-01',
      lastDay: '2025-12-31',
    },
  ],
} as const);

export interface BackfillChunk {
  /** `<product>/<startDate>/<dayRange>d` — the manifest key, stable across runs. */
  readonly chunkId: string;
  readonly source: SourceId;
  readonly product: string;
  /** `YYYY-MM-DD` — the API returns acquisitions for this day and the `dayRange - 1` after it. */
  readonly startDate: string;
  readonly dayRange: number;
  /** `firms/<product>/<year>/<product>_<startDate>_<dayRange>d.csv`, relative to the archive root. */
  readonly relativePath: string;
}

/**
 * One source's date range as API-sized chunks. Chunks never cross a calendar-year
 * boundary — the last chunk of each year is short instead — so every file under
 * `<product>/<year>/` holds acquisitions from that year only, and a per-year subset
 * (the GATES §2 fit/calibrate/test season splits) is a directory, not a filter.
 */
export function planChunks(spec: BackfillSourceSpec): readonly BackfillChunk[] {
  const first = epochDay(spec.firstDay);
  const last = epochDay(spec.lastDay);
  if (last < first) {
    throw new RangeError(
      `backfill spec for ${spec.product} ends (${spec.lastDay}) before it starts (${spec.firstDay})`,
    );
  }

  const chunks: BackfillChunk[] = [];
  let day = first;
  while (day <= last) {
    const year = yearOfEpochDay(day);
    const yearEnd = epochDay(`${String(year)}-12-31`);
    const remaining = Math.min(last, yearEnd) - day + 1;
    const dayRange = Math.min(MAX_ARCHIVE_DAY_RANGE, remaining);
    const startDate = formatEpochDay(day);
    chunks.push({
      chunkId: `${spec.product}/${startDate}/${String(dayRange)}d`,
      source: spec.source,
      product: spec.product,
      startDate,
      dayRange,
      relativePath:
        `firms/${spec.product}/${String(year)}/` +
        `${spec.product}_${startDate}_${String(dayRange)}d.csv`,
    });
    day += dayRange;
  }
  return chunks;
}

/**
 * The whole job: every chunk of every source, in plan order, plus the provenance header
 * the manifest pins. Sequential plan order on purpose — like the live poll cycle, a fixed
 * order means two runs over the same archive state produce the same sequence of requests.
 */
export interface BackfillJob {
  readonly plan: string;
  readonly planDigest: string;
  /** The exact `west,south,east,north` argument every request carries. */
  readonly area: string;
  readonly pollingBboxVersion: string;
  readonly chunks: readonly BackfillChunk[];
}

export function backfillJob(
  plan: typeof BACKFILL_PLAN = BACKFILL_PLAN,
  bbox: typeof POLLING_BBOX = POLLING_BBOX,
): BackfillJob {
  return {
    plan: plan.version,
    planDigest: plan.digest,
    area: firmsAreaArgument(bbox.values),
    pollingBboxVersion: bbox.version,
    chunks: plan.values.sources.flatMap((spec) => planChunks(spec)),
  };
}

/** The chunk as an Area API query; the adapter turns it into the one URL that holds the key. */
export function chunkQuery(chunk: BackfillChunk, area: string): FirmsAreaQuery {
  return {
    source: chunk.source,
    product: chunk.product,
    area,
    dayRange: chunk.dayRange,
    startDate: chunk.startDate,
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Days since the epoch, UTC. Round-tripped through the formatter so `2020-02-31` is a
 * refused typo rather than a silent rollover into March — a plan edited by hand must not
 * be able to shift a window without anyone noticing.
 */
function epochDay(day: string): number {
  if (!DAY_RE.test(day)) {
    throw new RangeError(`day must be YYYY-MM-DD, got ${JSON.stringify(day)}`);
  }
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms) || formatEpochDay(ms / DAY_MS) !== day) {
    throw new RangeError(`not a real calendar day: ${JSON.stringify(day)}`);
  }
  return ms / DAY_MS;
}

function formatEpochDay(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

function yearOfEpochDay(days: number): number {
  return new Date(days * DAY_MS).getUTCFullYear();
}
