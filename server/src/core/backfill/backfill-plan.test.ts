import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import {
  BACKFILL_PLAN,
  MAX_ARCHIVE_DAY_RANGE,
  backfillJob,
  chunkQuery,
  planChunks,
  type BackfillSourceSpec,
} from './backfill-plan.js';

const SNPP_SPEC: BackfillSourceSpec = {
  source: 'firms:viirs:snpp',
  product: 'VIIRS_SNPP_SP',
  firstDay: '2020-01-01',
  lastDay: '2025-12-31',
};

/** Every `YYYY-MM-DD` a chunk covers, expanded day by day. */
function coveredDays(chunks: ReturnType<typeof planChunks>): string[] {
  const days: string[] = [];
  for (const chunk of chunks) {
    const start = Date.parse(`${chunk.startDate}T00:00:00Z`);
    for (let i = 0; i < chunk.dayRange; i += 1) {
      days.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
    }
  }
  return days;
}

describe('planChunks', () => {
  it('covers every day of the range exactly once, leap days included', () => {
    const days = coveredDays(planChunks(SNPP_SPEC));

    // 2020-01-01..2025-12-31 = 2192 days: four 365-day years plus 2020 and 2024 at 366.
    expect(days).toHaveLength(2192);
    expect(new Set(days).size).toBe(2192);
    expect(days).toContain('2020-02-29');
    expect(days).toContain('2024-02-29');
    expect(days[0]).toBe('2020-01-01');
    expect(days.at(-1)).toBe('2025-12-31');
  });

  it('keeps every chunk within one calendar year, shortening the last chunk instead', () => {
    for (const chunk of planChunks(SNPP_SPEC)) {
      const start = Date.parse(`${chunk.startDate}T00:00:00Z`);
      const end = new Date(start + (chunk.dayRange - 1) * 86_400_000);
      expect(end.toISOString().slice(0, 4)).toBe(chunk.startDate.slice(0, 4));
    }
  });

  it('never asks the API for more days than it serves', () => {
    for (const chunk of planChunks(SNPP_SPEC)) {
      expect(chunk.dayRange).toBeGreaterThanOrEqual(1);
      expect(chunk.dayRange).toBeLessThanOrEqual(MAX_ARCHIVE_DAY_RANGE);
      expect(Number.isInteger(chunk.dayRange)).toBe(true);
    }
  });

  it('is 37 chunks per year — 36 full windows and one short one', () => {
    const chunks = planChunks(SNPP_SPEC);

    expect(chunks).toHaveLength(222); // 6 years × 37
    const in2021 = chunks.filter((chunk) => chunk.startDate.startsWith('2021-'));
    expect(in2021).toHaveLength(37);
    expect(in2021.at(-1)).toMatchObject({ startDate: '2021-12-27', dayRange: 5 });
    // Leap year: the tail chunk starts a day earlier and is a day longer.
    const tail2020 = chunks.filter((chunk) => chunk.startDate.startsWith('2020-')).at(-1);
    expect(tail2020).toMatchObject({ startDate: '2020-12-26', dayRange: 6 });
  });

  it('names chunks and files so the year directory tells the truth', () => {
    const chunk = planChunks(SNPP_SPEC)[0];

    expect(chunk?.chunkId).toBe('VIIRS_SNPP_SP/2020-01-01/10d');
    expect(chunk?.relativePath).toBe('firms/VIIRS_SNPP_SP/2020/VIIRS_SNPP_SP_2020-01-01_10d.csv');
  });

  it('refuses a spec whose dates are typos rather than days', () => {
    expect(() => planChunks({ ...SNPP_SPEC, firstDay: '2020-02-31' })).toThrow(/calendar day/);
    expect(() => planChunks({ ...SNPP_SPEC, firstDay: '2020/01/01' })).toThrow(/YYYY-MM-DD/);
    expect(() => planChunks({ ...SNPP_SPEC, lastDay: '2019-12-31' })).toThrow(/before it starts/);
  });
});

describe('backfillJob', () => {
  it('walks all three SP sources over the polling bbox', () => {
    const job = backfillJob();

    expect(job.plan).toBe('firms_sp_backfill_2020_2025_v1');
    expect(job.planDigest).toBe(BACKFILL_PLAN.digest);
    expect(job.area).toBe('20,39,31,46');
    expect(job.pollingBboxVersion).toBe('polling_bbox_v1');
    expect(job.chunks).toHaveLength(666); // 3 sources × 222
    expect(new Set(job.chunks.map((chunk) => chunk.product))).toEqual(
      new Set(['MODIS_SP', 'VIIRS_SNPP_SP', 'VIIRS_NOAA20_SP']),
    );
    // NOAA-21 has no SP product — its absence is a plan decision, not an oversight.
    expect(job.chunks.some((chunk) => chunk.product.includes('NOAA21'))).toBe(false);
  });

  it('keeps chunk ids unique across the whole job — they key the manifest', () => {
    const job = backfillJob();

    expect(new Set(job.chunks.map((chunk) => chunk.chunkId)).size).toBe(job.chunks.length);
  });

  it('accepts a substitute plan, which is how tests drive small jobs', () => {
    const plan = defineConfig('firms_sp_backfill', 'firms_sp_backfill_test_v1', {
      sources: [{ ...SNPP_SPEC, firstDay: '2024-01-01', lastDay: '2024-01-12' }],
    });

    const job = backfillJob(plan);

    expect(job.plan).toBe('firms_sp_backfill_test_v1');
    expect(job.chunks.map((chunk) => chunk.dayRange)).toEqual([10, 2]);
  });
});

describe('chunkQuery', () => {
  it('carries the SP product, the area and the start date into the port query', () => {
    const chunk = planChunks(SNPP_SPEC)[0];
    if (chunk === undefined) throw new Error('plan produced no chunks');

    expect(chunkQuery(chunk, '20,39,31,46')).toEqual({
      source: 'firms:viirs:snpp',
      product: 'VIIRS_SNPP_SP',
      area: '20,39,31,46',
      dayRange: 10,
      startDate: '2020-01-01',
    });
  });
});
