import { describe, expect, it } from 'vitest';

import type { ManifestEntry } from '../backfill/backfill-manifest.js';
import { emptyManifest, renderManifest, withEntry } from '../backfill/backfill-manifest.js';
import type { BackfillChunk, BackfillJob, BACKFILL_PLAN } from '../backfill/backfill-plan.js';
import { backfillJob } from '../backfill/backfill-plan.js';
import { defineConfig } from '../config/versioned-config.js';
import type { AppendResult, DetectionRecord } from '../ports/detection-store.js';
import type { DetectionUidFn } from '../ports/firms-client.js';
import type { MonthRecluster } from '../ports/month-recluster.js';
import type { SpArchiveReader } from '../ports/sp-archive-reader.js';
import type { SpStagingStore } from '../ports/sp-staging-store.js';
import type { SwapObservations } from './sanity-checks.js';
import { runPromotion } from './promotion-run.js';

function testJob(): BackfillJob {
  const plan: typeof BACKFILL_PLAN = defineConfig('firms_sp_backfill', 'firms_sp_backfill_t_v1', {
    sources: [
      {
        source: 'firms:viirs:snpp',
        product: 'VIIRS_SNPP_SP',
        firstDay: '2020-07-01',
        lastDay: '2020-07-31',
      },
    ],
  });
  return backfillJob(plan);
}

const HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight';

const ONE_ROW =
  `${HEADER}\n` +
  'BGR,41.850123,26.140027,330.5,0.39,0.36,2020-07-05,1124,N,VIIRS,n,2.0,295.1,12.5,D';

function completeEntry(chunk: BackfillChunk): ManifestEntry {
  return {
    source: chunk.source,
    product: chunk.product,
    start_date: chunk.startDate,
    day_range: chunk.dayRange,
    path: chunk.relativePath,
    status: 'complete',
    fetched_at: '2026-08-01T12:00:00Z',
    bytes: 1_024,
    sha256: 'a'.repeat(64),
  };
}

/** Archive whose every chunk is complete; the first chunk carries one July row. */
function syntheticArchive(job: BackfillJob): SpArchiveReader {
  let manifest = emptyManifest(job);
  const files = new Map<string, string>();
  job.chunks.forEach((chunk, index) => {
    manifest = withEntry(manifest, chunk.chunkId, completeEntry(chunk));
    files.set(chunk.relativePath, index === 0 ? ONE_ROW : HEADER);
  });
  const manifestText = renderManifest(manifest);
  return {
    readFile: (relativePath) => Promise.resolve(files.get(relativePath) ?? null),
    readManifest: () => Promise.resolve(manifestText),
  };
}

const CLEAN_OBSERVATIONS: SwapObservations = {
  liveRows: 1,
  liveNonNrtRows: 0,
  liveSourceDays: [{ source: 'firms:viirs:snpp', day: '2020-07-05' }],
  stagedRows: 1,
  stagedSourceDays: [{ source: 'firms:viirs:snpp', day: '2020-07-05' }],
  stagedOutsideMonth: 0,
  stagedOutsideBbox: 0,
  stagedDuplicateUids: 0,
};

interface FakeStaging {
  readonly store: SpStagingStore;
  readonly calls: string[];
  readonly loaded: DetectionRecord[][];
}

function fakeStaging(observations: SwapObservations): FakeStaging {
  const calls: string[] = [];
  const loaded: DetectionRecord[][] = [];
  const store: SpStagingStore = {
    prepareStaging: (): Promise<void> => {
      calls.push('prepare');
      return Promise.resolve();
    },
    loadStaged: (_window, records): Promise<AppendResult> => {
      calls.push('load');
      loaded.push([...records]);
      return Promise.resolve({
        received: records.length,
        inserted: records.length,
        alreadyPresent: 0,
      });
    },
    observe: (): Promise<SwapObservations> => {
      calls.push('observe');
      return Promise.resolve(observations);
    },
    swap: (window): ReturnType<SpStagingStore['swap']> => {
      calls.push('swap');
      return Promise.resolve({
        retiredTable: window.retiredTable,
        attachedPartition: window.livePartition,
      });
    },
  };
  return { store, calls, loaded };
}

function spyRecluster(): { recluster: MonthRecluster; months: string[] } {
  const months: string[] = [];
  return {
    months,
    recluster: {
      reclusterMonth: (request): ReturnType<MonthRecluster['reclusterMonth']> => {
        months.push(request.month);
        return Promise.resolve({ status: 'skipped_no_engine' });
      },
    },
  };
}

const uid: DetectionUidFn = (parts) =>
  [parts.source, parts.acqTsIso, parts.lat, parts.lon].join('|');

interface RunSetup {
  readonly observations?: SwapObservations;
  readonly archive?: SpArchiveReader;
}

function setup(options: RunSetup = {}): {
  job: BackfillJob;
  staging: FakeStaging;
  months: string[];
  lines: string[];
  deps: Parameters<typeof runPromotion>[2];
} {
  const job = testJob();
  const staging = fakeStaging(options.observations ?? CLEAN_OBSERVATIONS);
  const { recluster, months } = spyRecluster();
  const lines: string[] = [];
  return {
    job,
    staging,
    months,
    lines,
    deps: {
      archive: options.archive ?? syntheticArchive(job),
      staging: staging.store,
      recluster,
      detectionUid: uid,
      writeLine: (line: string) => lines.push(line),
    },
  };
}

describe('runPromotion', () => {
  it('dry-run stages and checks for real but never swaps', async () => {
    const { job, staging, months, lines, deps } = setup();
    const summary = await runPromotion(
      { month: '2020-07', dryRun: true, operatorConfirmed: true },
      job,
      deps,
    );

    expect(summary.decision).toBe('would_swap');
    expect(summary.verdict).toBe('needs_operator');
    expect(summary.swap).toBeNull();
    expect(summary.recluster).toBeNull();
    expect(summary.stagedRows).toBe(1);
    expect(staging.calls).toEqual(['prepare', 'load', 'observe']);
    expect(months).toEqual([]);
    // One staged line plus the six check lines.
    expect(lines.filter((line) => line.includes('sp_promotion_staged'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('sp_swap_check'))).toHaveLength(6);
    // The staged rows went through the SP mapping before reaching the store.
    expect(staging.loaded[0]?.[0]?.productTier).toBe('SP');
  });

  it('blocks an unconfirmed run while the band is unfitted', async () => {
    const { job, staging, deps } = setup();
    const summary = await runPromotion(
      { month: '2020-07', dryRun: false, operatorConfirmed: false },
      job,
      deps,
    );
    expect(summary.decision).toBe('blocked_needs_operator');
    expect(staging.calls).not.toContain('swap');
  });

  it('swaps and invokes the re-cluster hook on a confirmed real run', async () => {
    const { job, staging, months, deps } = setup();
    const summary = await runPromotion(
      { month: '2020-07', dryRun: false, operatorConfirmed: true },
      job,
      deps,
    );
    expect(summary.decision).toBe('swapped');
    expect(summary.swap).toEqual({
      retiredTable: 'detections_2020_07_nrt_retired',
      attachedPartition: 'detections_2020_07',
    });
    expect(summary.recluster).toEqual({ status: 'skipped_no_engine' });
    expect(staging.calls).toEqual(['prepare', 'load', 'observe', 'swap']);
    expect(months).toEqual(['2020-07']);
  });

  it('a failed check aborts before the swap, confirmation or not', async () => {
    const { job, staging, months, deps } = setup({
      observations: { ...CLEAN_OBSERVATIONS, stagedOutsideBbox: 1 },
    });
    const summary = await runPromotion(
      { month: '2020-07', dryRun: false, operatorConfirmed: true },
      job,
      deps,
    );
    expect(summary.decision).toBe('blocked_failed');
    expect(summary.verdict).toBe('fail');
    expect(staging.calls).not.toContain('swap');
    expect(months).toEqual([]);
  });

  it('throws when the archive has no manifest', async () => {
    const { job, deps } = setup({
      archive: {
        readFile: () => Promise.resolve(null),
        readManifest: () => Promise.resolve(null),
      },
    });
    await expect(
      runPromotion({ month: '2020-07', dryRun: true, operatorConfirmed: false }, job, deps),
    ).rejects.toThrow(/run the backfill first/);
  });

  it('refuses a manifest written under a different plan', async () => {
    const { job, deps } = setup();
    const foreign = { ...testJob(), area: '0.0,0.0,1.0,1.0' };
    const foreignText = renderManifest(emptyManifest(foreign));
    await expect(
      runPromotion({ month: '2020-07', dryRun: true, operatorConfirmed: false }, job, {
        ...deps,
        archive: {
          readFile: () => Promise.resolve(null),
          readManifest: () => Promise.resolve(foreignText),
        },
      }),
    ).rejects.toThrow(/area/);
  });
});
