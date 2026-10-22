import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectionUid } from '@fire-watch/contracts/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CANDIDATE_FILE } from '../core/fit/fit-report.js';
import { ConfigError } from './config.js';
import {
  CONSTELLATION_REPORT_JSON,
  CONSTELLATION_REPORT_MD,
  parseConstellationReplayArgs,
  REFIT_DIR,
  runConstellationReplayCli,
} from './constellation-replay-cli-run.js';
import { REPORT_JSON, REPORT_MD } from './fit-cli-run.js';
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

/** S-NPP (dropped in 2027) and NOAA-20 (live) see the same two fires an hour apart. */
const PRODUCTS = [
  { product: 'VIIRS_SNPP_SP', satellite: 'N', hour: '12' },
  { product: 'VIIRS_NOAA20_SP', satellite: '1', hour: '13' },
];

function viirsRow(year: number, lat: number, lon: number, satellite: string, hhmm: string): string {
  return [
    'BGR',
    lat.toFixed(6),
    lon.toFixed(6),
    '330.5',
    '0.39',
    '0.36',
    `${String(year)}-07-10`,
    hhmm,
    satellite,
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
    for (const p of PRODUCTS) {
      const rows = FIRES.flatMap((f) => [
        viirsRow(year, 42.7, f.lon, p.satellite, `${p.hour}00`),
        viirsRow(year, 42.7005, f.lon + 0.0005, p.satellite, `${p.hour}05`),
        viirsRow(year, 42.6995, f.lon + 0.001, p.satellite, `${p.hour}10`),
      ]);
      const dir = join(root, 'firms', p.product, String(year));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'chunk.csv'), `${[VIIRS_HEADER, ...rows].join('\n')}\n`);
    }
    await mkdir(join(root, 'effis'), { recursive: true });
    await writeFile(
      join(root, 'effis', `modis.ba.poly.${String(year)}.geojson`),
      JSON.stringify({
        type: 'FeatureCollection',
        features: FIRES.map((f) => perimeter(year, f)),
      }),
    );
  }
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
    deps: { log, nowIso: () => '2026-10-22T00:00:00.000Z', detectionUid, cwd },
  };
}

function summary(out: readonly string[]): Record<string, unknown> {
  const line = out.find((l) => l.includes('constellation_replay'));
  if (line === undefined) throw new Error('no summary line');
  return (JSON.parse(line) as { constellation_replay: Record<string, unknown> })
    .constellation_replay;
}

let root: string;
let input: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fire-watch-l14-'));
  input = join(root, 'input');
  await writeInput(input);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('constellation replay CLI arguments', () => {
  it('resolves paths and defaults to the 2027 constellation', () => {
    expect(parseConstellationReplayArgs(['--input=in', '--out=/abs/out'], '/work')).toMatchObject({
      inputDir: '/work/in',
      outDir: '/abs/out',
      synthetic: false,
      constellation: 'constellation_2027_v1',
    });
  });

  it('rejects unknown, empty and missing arguments, including --touch-test-season', () => {
    const parse = (argv: string[]) => () => parseConstellationReplayArgs(argv, '/');
    expect(parse(['--input=a', '--out=b', '--touch-test-season'])).toThrow(ConfigError);
    expect(parse(['--input=', '--out=b'])).toThrow(ConfigError);
    expect(parse(['--out=b'])).toThrow(ConfigError);
    expect(parse(['--input=a'])).toThrow(ConfigError);
  });
});

describe('constellation replay CLI — refusals', () => {
  it('refuses a real run while DS-1 and DS-3 have no dated --check row', async () => {
    const { deps, out } = harness(root);
    const run = runConstellationReplayCli(
      [`--input=${input}`, `--out=${join(root, 'refused')}`],
      deps,
    );
    await expect(run).rejects.toThrow(ConfigError);
    await expect(run).rejects.toThrow(/refusing to replay/);
    expect(out).toEqual([]);
  });

  it('refuses an unknown constellation', async () => {
    const { deps } = harness(root);
    await expect(
      runConstellationReplayCli(
        [`--input=${input}`, `--out=${join(root, 'x')}`, '--synthetic', '--constellation=nope_v1'],
        deps,
      ),
    ).rejects.toThrow(/unknown constellation nope_v1/);
  });
});

describe('constellation replay CLI — end-to-end synthetic replay', () => {
  it('drops S-NPP, judges the incumbent on NOAA-20 alone and says what it could not measure', async () => {
    const outDir = join(root, 'out');
    const { deps, out } = harness(root);
    expect(
      await runConstellationReplayCli([`--input=${input}`, `--out=${outDir}`, '--synthetic'], deps),
    ).toBe(0);

    expect(summary(out)).toMatchObject({
      mode: 'synthetic',
      constellation: 'constellation_2027_v1',
      // The thresholds hold, but NOAA-21 and SLSTR have no rows: not a pass.
      outcome: 'pass_unproven',
      refit_required: false,
      missing_live_sources: ['firms:viirs:noaa21', 'eumetsat:slstr:frp'],
    });

    const report = JSON.parse(await readFile(join(outDir, CONSTELLATION_REPORT_JSON), 'utf8')) as {
      restriction: Record<string, unknown>;
      coverage: { fit: { seasons: number[]; rowsBySource: Record<string, number> } };
      acceptance: { fit: { seasons: number[]; verdict: { pass: boolean } } };
      refit: { selected: string | null };
    };
    expect(report.restriction).toEqual({
      detectionRows: 72,
      keptDetectionRows: 36,
      geoRows: 0,
      keptGeoRows: 0,
      droppedRows: { 'firms:viirs:snpp': 36 },
    });
    expect(report.coverage.fit).toEqual({
      seasons: [2020, 2021, 2022, 2023],
      rowsBySource: { 'firms:viirs:noaa20': 24 },
    });
    // The test season is never part of the acceptance.
    expect(report.acceptance.fit.seasons).toEqual([2020, 2021, 2022, 2023]);
    expect(report.acceptance.fit.verdict.pass).toBe(true);
    expect(report.refit.selected).not.toBeNull();

    const markdown = await readFile(join(outDir, CONSTELLATION_REPORT_MD), 'utf8');
    expect(markdown).toContain('PASS_UNPROVEN');
    expect(markdown).toContain('S-NPP anticipated end of life');
    expect(markdown).toContain('source:firms:viirs:noaa20|pooled');
    expect(markdown).not.toContain('source:firms:viirs:snpp');

    // The re-fit is an ordinary fit report under refit/, test season untouched.
    const refit = JSON.parse(await readFile(join(outDir, REFIT_DIR, REPORT_JSON), 'utf8')) as {
      result: { test: { touched: boolean } };
    };
    expect(refit.result.test.touched).toBe(false);
    await expect(readFile(join(outDir, REFIT_DIR, REPORT_MD), 'utf8')).resolves.toContain(
      'synthetic',
    );
    await expect(readFile(join(outDir, REFIT_DIR, CANDIDATE_FILE), 'utf8')).resolves.toContain(
      '"active": false',
    );
  });
});
