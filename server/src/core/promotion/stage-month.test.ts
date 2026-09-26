import { describe, expect, it } from 'vitest';

import type { BackfillManifest, ManifestEntry } from '../backfill/backfill-manifest.js';
import { emptyManifest, withEntry } from '../backfill/backfill-manifest.js';
import type { BackfillChunk, BackfillJob, BACKFILL_PLAN } from '../backfill/backfill-plan.js';
import { backfillJob } from '../backfill/backfill-plan.js';
import { defineConfig } from '../config/versioned-config.js';
import { FirmsCsvFormatError } from '../ingest/firms-csv.js';
import type { DetectionUidFn } from '../ports/firms-client.js';
import type { SpArchiveReader } from '../ports/sp-archive-reader.js';
import { monthWindow } from './month-window.js';
import { monthChunks, stageMonth } from './stage-month.js';

// A one-month, one-source plan: July 2020 falls into chunks 07-01, 07-11, 07-21, 07-31.
function testJob(firstDay = '2020-07-01', lastDay = '2020-07-31'): BackfillJob {
  const plan: typeof BACKFILL_PLAN = defineConfig('firms_sp_backfill', 'firms_sp_backfill_t_v1', {
    sources: [{ source: 'firms:viirs:snpp', product: 'VIIRS_SNPP_SP', firstDay, lastDay }],
  });
  return backfillJob(plan);
}

const FETCHED_AT = '2026-08-01T12:00:00Z';

function completeEntry(chunk: BackfillChunk): ManifestEntry {
  return {
    source: chunk.source,
    product: chunk.product,
    start_date: chunk.startDate,
    day_range: chunk.dayRange,
    path: chunk.relativePath,
    status: 'complete',
    fetched_at: FETCHED_AT,
    bytes: 1_024,
    sha256: 'a'.repeat(64),
  };
}

function completeManifest(job: BackfillJob): BackfillManifest {
  let manifest = emptyManifest(job);
  for (const chunk of job.chunks) {
    manifest = withEntry(manifest, chunk.chunkId, completeEntry(chunk));
  }
  return manifest;
}

const HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight';

function row(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    country_id: 'BGR',
    latitude: '41.850123',
    longitude: '26.140027',
    bright_ti4: '330.5',
    scan: '0.39',
    track: '0.36',
    acq_date: '2020-07-05',
    acq_time: '1124',
    satellite: 'N',
    instrument: 'VIIRS',
    confidence: 'n',
    version: '2.0',
    bright_ti5: '295.1',
    frp: '12.5',
    daynight: 'D',
    ...overrides,
  };
  return HEADER.split(',')
    .map((name) => values[name] ?? '')
    .join(',');
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

/** In-memory archive: relative path → CSV text; unknown paths answer null. */
function archiveOf(files: ReadonlyMap<string, string>): SpArchiveReader {
  return {
    readFile: (relativePath) => Promise.resolve(files.get(relativePath) ?? null),
    readManifest: () => Promise.resolve(null),
  };
}

const uid: DetectionUidFn = (parts) =>
  [parts.source, parts.acqTsIso, parts.lat, parts.lon].join('|');

/** Every chunk gets a header-only CSV unless the test supplies one. */
function filesFor(job: BackfillJob, byStartDate: Record<string, string> = {}): Map<string, string> {
  const files = new Map<string, string>();
  for (const chunk of job.chunks) {
    files.set(chunk.relativePath, byStartDate[chunk.startDate] ?? csv());
  }
  return files;
}

describe('monthChunks', () => {
  it('selects every chunk overlapping the month, not only those inside it', () => {
    // The 10-day grid anchored at 06-25 puts July's first days in a June-started chunk.
    const job = testJob('2020-06-25', '2020-07-05');
    const chunks = monthChunks(job, monthWindow('2020-07'));
    expect(chunks.map((chunk) => chunk.startDate)).toEqual(['2020-06-25', '2020-07-05']);
  });

  it('excludes a chunk that ends exactly at the month boundary', () => {
    const job = testJob();
    expect(monthChunks(job, monthWindow('2020-08'))).toEqual([]);
    expect(monthChunks(job, monthWindow('2020-07'))).toHaveLength(4);
  });
});

describe('stageMonth', () => {
  const window = monthWindow('2020-07');

  it('stages the month as SP records through the live parsing pipeline', async () => {
    const job = testJob();
    const files = filesFor(job, {
      '2020-07-01': csv(row(), row({ acq_date: '2020-06-30' })),
    });
    const staged = await stageMonth(window, job, completeManifest(job), {
      archive: archiveOf(files),
      detectionUid: uid,
    });

    expect(staged.chunksRead).toBe(4);
    expect(staged.rowsParsed).toBe(2);
    expect(staged.rowsOutsideMonth).toBe(1);
    expect(staged.rowsRejected).toBe(0);
    expect(staged.records).toHaveLength(1);

    const record = staged.records[0];
    expect(record).toMatchObject({
      source: 'firms:viirs:snpp',
      productTier: 'SP',
      acqTsIso: '2020-07-05T11:24:00Z',
      lat: '41.85012',
      lon: '26.14003',
      collectionVersion: '2.0',
      quarantined: false,
    });
    expect(record?.detectionUid).toBe(
      uid({
        source: 'firms:viirs:snpp',
        acqTsIso: '2020-07-05T11:24:00Z',
        lat: '41.85012',
        lon: '26.14003',
      }),
    );
    expect(record?.availableAt).toBe(Date.parse(FETCHED_AT));
    expect(record?.ingestConfigVersion).toBe(job.pollingBboxVersion);
  });

  it('maps an empty version column to a null collection_version', async () => {
    const job = testJob();
    const files = filesFor(job, { '2020-07-01': csv(row({ version: '' })) });
    const staged = await stageMonth(window, job, completeManifest(job), {
      archive: archiveOf(files),
      detectionUid: uid,
    });
    expect(staged.records[0]?.collectionVersion).toBeNull();
  });

  it('orders records deterministically across chunks', async () => {
    const job = testJob();
    const files = filesFor(job, {
      // Later acquisition listed first inside the file; a second chunk contributes too.
      '2020-07-01': csv(row({ acq_date: '2020-07-09' }), row({ acq_date: '2020-07-02' })),
      '2020-07-11': csv(row({ acq_date: '2020-07-12' })),
    });
    const staged = await stageMonth(window, job, completeManifest(job), {
      archive: archiveOf(files),
      detectionUid: uid,
    });
    // Same availableAt and source for all three → the uid (over acq_ts) breaks the tie.
    expect(staged.records.map((record) => record.acqTsIso)).toEqual([
      '2020-07-02T11:24:00Z',
      '2020-07-09T11:24:00Z',
      '2020-07-12T11:24:00Z',
    ]);
  });

  it('drops a repeated uid and counts it', async () => {
    const job = testJob();
    const files = filesFor(job, { '2020-07-01': csv(row(), row()) });
    const staged = await stageMonth(window, job, completeManifest(job), {
      archive: archiveOf(files),
      detectionUid: uid,
    });
    expect(staged.records).toHaveLength(1);
    expect(staged.duplicatesWithinMonth).toBe(1);
  });

  it('counts a row-level rejection and keeps the rest', async () => {
    const job = testJob();
    const files = filesFor(job, {
      '2020-07-01': csv(row(), row({ latitude: 'not-a-degree' })),
    });
    const staged = await stageMonth(window, job, completeManifest(job), {
      archive: archiveOf(files),
      detectionUid: uid,
    });
    expect(staged.records).toHaveLength(1);
    expect(staged.rowsRejected).toBe(1);
  });

  it('throws when the plan has no chunks covering the month', async () => {
    const job = testJob();
    await expect(
      stageMonth(monthWindow('2021-01'), job, completeManifest(job), {
        archive: archiveOf(filesFor(job)),
        detectionUid: uid,
      }),
    ).rejects.toThrow(/no chunks covering 2021-01/);
  });

  it('refuses a month whose manifest entries are not all complete', async () => {
    const job = testJob();
    let manifest = completeManifest(job);
    const failed = job.chunks[2];
    if (failed === undefined) throw new Error('expected four chunks');
    manifest = withEntry(manifest, failed.chunkId, {
      ...completeEntry(failed),
      status: 'failed',
      error: 'HTTP 503',
    });
    await expect(
      stageMonth(window, job, manifest, { archive: archiveOf(filesFor(job)), detectionUid: uid }),
    ).rejects.toThrow(new RegExp(`does not vouch for ${failed.product}/${failed.startDate}`));
  });

  it('refuses a month with a chunk missing from the manifest entirely', async () => {
    const job = testJob();
    const manifest = emptyManifest(job);
    await expect(
      stageMonth(window, job, manifest, { archive: archiveOf(filesFor(job)), detectionUid: uid }),
    ).rejects.toThrow(/does not vouch for/);
  });

  it('throws when a vouched-for file is missing from the archive', async () => {
    const job = testJob();
    const files = filesFor(job);
    const first = job.chunks[0];
    if (first === undefined) throw new Error('expected four chunks');
    files.delete(first.relativePath);
    await expect(
      stageMonth(window, job, completeManifest(job), {
        archive: archiveOf(files),
        detectionUid: uid,
      }),
    ).rejects.toThrow(new RegExp(`${first.relativePath} is missing`));
  });

  it('propagates a whole-file format problem instead of skipping the chunk', async () => {
    const job = testJob();
    const files = filesFor(job, { '2020-07-01': 'latitude,longitude\n41.8,26.1' });
    await expect(
      stageMonth(window, job, completeManifest(job), {
        archive: archiveOf(files),
        detectionUid: uid,
      }),
    ).rejects.toThrow(FirmsCsvFormatError);
  });
});
