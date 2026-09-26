import { inflateSync } from 'node:zlib';

import { PredefinedNetworkConditions } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';

import { paddedPng } from '../harness/stand-in-basemap.js';
import {
  CPU_CALIBRATION,
  MAP_READY_BUDGETS,
  MAP_READY_RUNS,
  STAND_IN_BASEMAP,
  TARGET_BENCHMARK_MS,
} from './map-ready-budget.js';
import { calibrateCpu, formatReport, median, verdict } from './map-ready-stats.js';
import type { TimingRun } from './map-ready-stats.js';

const run = (mapReadyMs: number): TimingRun => ({
  mapReadyMs,
  cpuRate: 4,
  hostBenchmarkMs: 20,
  marks: { 'fw:snapshot-applied': mapReadyMs / 2 },
});

describe('map-ready budget data', () => {
  it('uses the DevTools presets it names, number for number', () => {
    for (const budget of MAP_READY_BUDGETS) {
      const { preset, ...conditions } = budget.network;
      expect(conditions).toEqual(PredefinedNetworkConditions[preset]);
    }
  });

  it('keeps 08 §5.5.2 budgets: 6 s on 4G, 15 s on 3G', () => {
    expect(MAP_READY_BUDGETS.map((budget) => [budget.id, budget.budgetMs])).toEqual([
      ['4g', 6_000],
      ['3g', 15_000],
    ]);
  });

  it('decides on an odd number of runs, so the median is a run', () => {
    expect(MAP_READY_RUNS.runs % 2).toBe(1);
    expect(MAP_READY_RUNS.maxAttempts).toBeGreaterThanOrEqual(MAP_READY_RUNS.runs);
  });

  it('targets the reference slowdown of the fast host', () => {
    expect(TARGET_BENCHMARK_MS).toBe(
      CPU_CALIBRATION.referenceSlowdown * CPU_CALIBRATION.fastHostBenchmarkMs,
    );
  });
});

describe('median', () => {
  it('takes the middle value of an odd set and the mean of the middle pair of an even one', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('ignores one outlier', () => {
    expect(median([1000, 1100, 90_000, 1050, 1020])).toBe(1050);
  });

  it('refuses an empty set', () => {
    expect(() => median([])).toThrow();
  });
});

describe('calibrateCpu', () => {
  it('slows an idle fast host by the reference slowdown', () => {
    expect(calibrateCpu(20, 80, 8)).toEqual({ representative: true, rate: 4, hostBenchmarkMs: 20 });
  });

  it('slows a loaded host less, so the page sees the same device', () => {
    expect(calibrateCpu(40, 80, 8)).toMatchObject({ representative: true, rate: 2 });
  });

  it('clamps an implausibly fast reading', () => {
    expect(calibrateCpu(1, 80, 8)).toMatchObject({ representative: true, rate: 8 });
  });

  it('rejects a host slower than the reference device', () => {
    expect(calibrateCpu(120, 80, 8)).toMatchObject({ representative: false });
  });

  it('rejects a benchmark that did not run', () => {
    expect(calibrateCpu(0, 80, 8)).toMatchObject({ representative: false });
    expect(calibrateCpu(Number.NaN, 80, 8)).toMatchObject({ representative: false });
  });
});

describe('verdict and report', () => {
  it('passes on a median at the budget and fails one over it', () => {
    expect(verdict('4g', 6_000, [5_000, 6_000, 9_000].map(run)).pass).toBe(true);
    expect(verdict('4g', 6_000, [5_000, 6_001, 9_000].map(run)).pass).toBe(false);
  });

  it('reports median, min and max and every run', () => {
    const runs = [5_000, 6_000, 9_000].map(run);
    const result = verdict('4g', 6_000, runs);
    expect(result).toMatchObject({ medianMs: 6_000, minMs: 5_000, maxMs: 9_000 });
    const report = formatReport(result, runs, ['host too slow']);
    expect(report).toContain('median 6000 ms (min 5000, max 9000) against 6000 ms — PASS');
    expect(report).toContain('fw:snapshot-applied ms');
    expect(report).toContain('skipped: host too slow');
    expect(report.split('\n')).toHaveLength(1 + 1 + 3 + 1);
  });
});

describe('stand-in basemap tile', () => {
  it('is a valid PNG of exactly the configured weight', () => {
    const png = paddedPng(STAND_IN_BASEMAP.tileSize, 0xe8, STAND_IN_BASEMAP.tileBytes);
    expect(png.length).toBe(STAND_IN_BASEMAP.tileBytes);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // Walk the chunks: IHDR, IDAT, the padding, IEND — and the pixels decode to the tone.
    const types: string[] = [];
    let offset = 8;
    let idat: Buffer = Buffer.alloc(0);
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.toString('latin1', offset + 4, offset + 8);
      types.push(type);
      if (type === 'IDAT') idat = png.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length;
    }
    expect(offset).toBe(png.length);
    expect(types).toEqual(['IHDR', 'IDAT', 'fwPd', 'IEND']);
    const pixels = inflateSync(idat);
    expect(pixels.length).toBe(STAND_IN_BASEMAP.tileSize * (STAND_IN_BASEMAP.tileSize + 1));
    expect(pixels[1]).toBe(0xe8);
  });

  it('refuses a weight below the bare image', () => {
    expect(() => paddedPng(256, 0, 10)).toThrow();
  });
});
