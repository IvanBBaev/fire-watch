import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectionUid } from '@fire-watch/contracts/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CANDIDATE_FILE } from '../core/fit/fit-report.js';
import { ConfigError } from './config.js';
import { LEDGER_FILE, parseFitArgs, REPORT_JSON, REPORT_MD, runFitCli } from './fit-cli-run.js';
import { createProcessLog } from './logging.js';

const VIIRS_HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight';

const SEASONS = [2020, 2021, 2022, 2023, 2024, 2025];

/** Fire A (30 ha) near 23.00° E and fire B (100 ha) near 23.13° E, ≈10.6 km apart. */
const FIRES = [
  { id: 'a', lon: 23.0, areaHa: 30 },
  { id: 'b', lon: 23.13, areaHa: 100 },
];

function viirsRow(year: number, lat: number, lon: number, hhmm: string): string {
  return [
    'BGR',
    lat.toFixed(6),
    lon.toFixed(6),
    '330.5',
    '0.39',
    '0.36',
    `${String(year)}-07-10`,
    hhmm,
    'N',
    'VIIRS',
    'n',
    '2',
    '295.1',
    '12.5',
    'D',
  ].join(',');
}

function perimeter(year: number, fire: (typeof FIRES)[number]) {
  const d = 0.01;
  return {
    type: 'Feature',
    properties: {
      id: fire.id,
      FIREDATE: `${String(year)}-07-10 00:00:00`,
      FINALDATE: `${String(year)}-07-11`,
      AREA_HA: fire.areaHa,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [fire.lon - d, 42.7 - d],
          [fire.lon + d, 42.7 - d],
          [fire.lon + d, 42.7 + d],
          [fire.lon - d, 42.7 + d],
          [fire.lon - d, 42.7 - d],
        ],
      ],
    },
  };
}

async function writeInput(root: string): Promise<void> {
  for (const year of SEASONS) {
    const rows = FIRES.flatMap((f) => [
      viirsRow(year, 42.7, f.lon, '1200'),
      viirsRow(year, 42.7005, f.lon + 0.0005, '1205'),
      viirsRow(year, 42.6995, f.lon + 0.001, '1210'),
    ]);
    const dir = join(root, 'firms', 'VIIRS_SNPP_SP', String(year));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chunk.csv'), `${[VIIRS_HEADER, ...rows].join('\n')}\n`);
    await mkdir(join(root, 'effis'), { recursive: true });
    await writeFile(
      join(root, 'effis', `modis.ba.poly.${String(year)}.geojson`),
      JSON.stringify({
        type: 'FeatureCollection',
        features: FIRES.map((f) => perimeter(year, f)),
      }),
    );
  }
  // A product the backfill plan never wrote is counted and ignored.
  await mkdir(join(root, 'firms', 'NOT_A_PRODUCT', '2021'), { recursive: true });
  await writeFile(join(root, 'firms', 'NOT_A_PRODUCT', '2021', 'x.csv'), `${VIIRS_HEADER}\n`);
  await mkdir(join(root, 'geo'), { recursive: true });
  await writeFile(
    join(root, 'geo', 'detections.json'),
    JSON.stringify(
      FIRES.map((f) => ({
        source: 'lsasaf:seviri:frp-pixel',
        acqTsIso: '2025-07-10T13:00:00Z',
        lat: 42.7,
        lon: f.lon + 0.002,
      })),
    ),
  );
}

function harness(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const log = createProcessLog({
    env: {},
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
  });
  return {
    out,
    err,
    deps: { log, nowIso: () => '2026-10-11T00:00:00.000Z', detectionUid, cwd },
  };
}

function summary(out: readonly string[]): Record<string, unknown> {
  const line = out.find((l) => l.includes('clustering_fit'));
  if (line === undefined) throw new Error('no summary line');
  return (JSON.parse(line) as { clustering_fit: Record<string, unknown> }).clustering_fit;
}

let root: string;
let input: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fire-watch-fit-'));
  input = join(root, 'input');
  await writeInput(input);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fit CLI arguments', () => {
  it('resolves paths and puts a synthetic ledger next to the outputs', () => {
    const args = parseFitArgs(['--input=in', '--out=/abs/out', '--synthetic'], '/work');
    expect(args).toMatchObject({
      inputDir: '/work/in',
      outDir: '/abs/out',
      synthetic: true,
      touchTestSeason: false,
      ledgerPath: `/abs/out/${LEDGER_FILE}`,
    });
    expect(parseFitArgs(['--input=in', '--out=o'], '/w').ledgerPath).toBe(`/w/in/${LEDGER_FILE}`);
    expect(parseFitArgs(['--input=in', '--out=o', '--ledger=l.json'], '/w').ledgerPath).toBe(
      '/w/l.json',
    );
  });

  it('rejects unknown, empty and missing arguments', () => {
    expect(() => parseFitArgs(['--input=a', '--out=b', '--fast'], '/')).toThrow(ConfigError);
    expect(() => parseFitArgs(['--input=', '--out=b'], '/')).toThrow(ConfigError);
    expect(() => parseFitArgs(['--out=b'], '/')).toThrow(ConfigError);
    expect(() => parseFitArgs(['--input=a'], '/')).toThrow(ConfigError);
  });
});

describe('fit CLI — refusals (23 E1)', () => {
  it('refuses a real run while DS-1 and DS-3 have no dated --check row', async () => {
    const { deps, out } = harness(root);
    const run = runFitCli([`--input=${input}`, `--out=${join(root, 'refused')}`], deps);
    await expect(run).rejects.toThrow(ConfigError);
    await expect(run).rejects.toThrow(/DS-1: no_check_date, DS-3: no_check_row/);
    expect(out).toEqual([]);
  });
});

describe('fit CLI — end-to-end synthetic fit', () => {
  it('sweeps the grid, picks the plateau centre and writes the report and candidate', async () => {
    const outDir = join(root, 'out');
    const { deps, out, err } = harness(root);
    expect(await runFitCli([`--input=${input}`, `--out=${outDir}`, '--synthetic'], deps)).toBe(0);

    expect(summary(out)).toEqual({
      mode: 'synthetic',
      cells: 150,
      // Every cell passes and is stable: the footprint slice (width 2) beats the fixed
      // slice (width 1, its MODIS axis has four values), and (2, 2) is the centre.
      selected: 'modis_footprint/v1.25/t48',
      fit_pass: true,
      calibrate_pass: true,
      test_touched: false,
      eps_geo: true,
      candidate: CANDIDATE_FILE,
      out: outDir,
    });
    expect(err.some((l) => l.includes('starting'))).toBe(true);

    const report = JSON.parse(await readFile(join(outDir, REPORT_JSON), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(report).toMatchObject({
      mode: 'synthetic',
      intake: {
        ds1_files: 6,
        ds1_files_unknown_product: 1,
        ds1_rows: 36,
        ds3_files: 6,
        ds3_perimeters: 12,
        ds4_rows: 2,
      },
    });
    const markdown = await readFile(join(outDir, REPORT_MD), 'utf8');
    expect(markdown).toContain('modis_footprint/v1.25/t48');
    expect(markdown).toContain('synthetic');

    const candidate = JSON.parse(await readFile(join(outDir, CANDIDATE_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(candidate).toMatchObject({ active: false, version: 'clustering_params_v2' });
    // The test season was not requested, so no ledger was written.
    await expect(readFile(join(outDir, LEDGER_FILE), 'utf8')).rejects.toThrow();
  });

  it('touches the test season once, records it, and refuses a second touch', async () => {
    const outDir = join(root, 'touched');
    const argv = [`--input=${input}`, `--out=${outDir}`, '--synthetic', '--touch-test-season'];
    const first = harness(root);
    expect(await runFitCli(argv, first.deps)).toBe(0);
    expect(summary(first.out)['test_touched']).toBe(true);
    const ledger = JSON.parse(await readFile(join(outDir, LEDGER_FILE), 'utf8')) as {
      touches: { selectedCellId: string; touchedAt: string }[];
    };
    expect(ledger.touches).toEqual([
      expect.objectContaining({
        selectedCellId: 'modis_footprint/v1.25/t48',
        touchedAt: '2026-10-11T00:00:00.000Z',
      }),
    ]);

    const second = harness(root);
    await expect(runFitCli(argv, second.deps)).rejects.toThrow(/test season again/);
  });
});
