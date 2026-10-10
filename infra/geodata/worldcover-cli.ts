#!/usr/bin/env node
/**
 * Builds the WorldCover land-cover product over the polling box (TASKS D10, DS-7):
 *
 *   data/worldcover-cache/worldcover-landcover-<version>.bin — the 0.005° class-share
 *   grid (git-ignored: ~37 MB)
 *   server/fixtures/worldcover-landcover.json — the committed manifest: every source
 *   file with its sha256, the grid spec, the product's sha256, a summary, and the
 *   WorldCover reading of the D5 S3 candidates
 *
 *   pnpm run geodata:worldcover [--cache <dir>] [--effis-cache <dir>] [--out <file>] [--refresh]
 *
 * Operator-run, never in CI. The box is read from the server's `polling_bbox` config
 * source, never restated here. Only the tiles the published grid lists over that box are
 * fetched (~1 GB) and cached with a sidecar recording when; the cached bytes and their
 * sha256 are the version the product cites. The S3 cross-check reads the EFFIS layers
 * cached by `pnpm run geodata:effis-ba` and refuses any whose sha256 differs from the
 * one D5 pinned.
 *
 * Exit codes: 0 ok, 1 a fetch or check failed.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parseLayer, type FeatureCollection } from './effis-ba-candidates.js';
import {
  CELL_PIXELS,
  CLASSES,
  CLASS_NAMES,
  FORMAT,
  GRID_URL,
  PIXELS_PER_DEGREE,
  POLYGON_SUBSAMPLES,
  PRODUCT_VERSION,
  SCALE,
  accumulateBlock,
  blockInGrid,
  decodeBlock,
  newCounts,
  parsePollingBbox,
  parseTiff,
  polygonClassCounts,
  polygonProductWeights,
  productGrid,
  quantize,
  readCounts,
  tileFileName,
  tileOriginPixels,
  tileUrl,
  tilesFromGrid,
  type GridCollection,
  type TiffInfo,
} from './worldcover.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The compiled CLI runs from `infra/geodata/dist/`; the repo root is three levels up.
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const USER_AGENT = 'fire-watch-geodata/0.1 (+https://github.com/IvanBBaev/fire-watch)';

const ATTRIBUTION =
  '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Cached {
  readonly bytes: Buffer;
  readonly fetchedAt: string;
}

async function cached(url: string, file: string, refresh: boolean): Promise<Cached> {
  const meta = `${file}.fetched`;
  if (!existsSync(file) || refresh) {
    console.log(`fetching ${url} …`);
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(900_000),
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    // eslint-disable-next-line no-restricted-syntax -- operator CLI recording the real fetch time
    writeFileSync(meta, `${new Date().toISOString()}\n`);
  }
  const fetchedAt = existsSync(meta)
    ? readFileSync(meta, 'utf8').trim()
    : statSync(file).mtime.toISOString();
  return { bytes: readFileSync(file), fetchedAt };
}

/** Full-resolution pixel reads across tiles, one decoded block kept per tile. */
class PixelReader {
  private readonly tiles = new Map<
    string,
    { bytes: Buffer; info: TiffInfo; x: number; y: number }
  >();
  private readonly blocks = new Map<string, Uint8Array>();

  constructor(private readonly cache: string) {}

  read = (x: number, y: number): number => {
    const lon = Math.floor(((x + 0.5) / PIXELS_PER_DEGREE - 180) / 3) * 3;
    const lat = Math.floor((90 - (y + 0.5) / PIXELS_PER_DEGREE) / 3) * 3;
    const name = `${lat < 0 ? 'S' : 'N'}${String(Math.abs(lat)).padStart(2, '0')}${lon < 0 ? 'W' : 'E'}${String(Math.abs(lon)).padStart(3, '0')}`;
    let tile = this.tiles.get(name);
    if (!tile) {
      const file = join(this.cache, tileFileName(name));
      if (!existsSync(file)) return 0; // no published tile: open sea, no data
      const bytes = readFileSync(file);
      const info = parseTiff(bytes);
      tile = { bytes, info, ...tileOriginPixels(info) };
      this.tiles.set(name, tile);
    }
    const col = x - tile.x;
    const row = y - tile.y;
    const index =
      Math.floor(row / tile.info.tileHeight) * tile.info.tilesAcross +
      Math.floor(col / tile.info.tileWidth);
    const key = `${name}:${String(index)}`;
    let block = this.blocks.get(key);
    if (!block) {
      block = decodeBlock(tile.bytes, tile.info, index);
      this.blocks.set(key, block);
    }
    return (
      block[(row % tile.info.tileHeight) * tile.info.tileWidth + (col % tile.info.tileWidth)] ?? 0
    );
  };
}

interface D5Fire {
  readonly effis_id: string;
  readonly layer: string;
  readonly commune: string;
  readonly firedate: string;
  readonly area_ha: number;
  readonly agri_pct: number | null;
}

interface D5Asset {
  readonly sources: readonly { readonly layer: string; readonly sha256: string }[];
  readonly scenarios: readonly {
    readonly scenario: string;
    readonly candidates: readonly { readonly rank: number; readonly fires: readonly D5Fire[] }[];
  }[];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string', default: join(REPO_ROOT, 'data', 'worldcover-cache') },
      'effis-cache': { type: 'string', default: join(REPO_ROOT, 'data', 'effis-ba-cache') },
      out: {
        type: 'string',
        default: join(REPO_ROOT, 'server', 'fixtures', 'worldcover-landcover.json'),
      },
      refresh: { type: 'boolean', default: false },
    },
  });
  const cacheDir = values.cache;
  mkdirSync(cacheDir, { recursive: true });

  const configPath = join(REPO_ROOT, 'server', 'src', 'core', 'config', 'polling-bbox.ts');
  const bbox = parsePollingBbox(readFileSync(configPath, 'utf8'));
  const grid = productGrid(bbox);
  console.log(
    `${bbox.version}: W${String(bbox.west)} S${String(bbox.south)} E${String(bbox.east)} N${String(bbox.north)}, ` +
      `${String(grid.cols)}×${String(grid.rows)} cells`,
  );

  const gridFile = await cached(
    GRID_URL,
    join(cacheDir, 'esa_worldcover_grid.geojson'),
    values.refresh,
  );
  const tiles = tilesFromGrid(JSON.parse(gridFile.bytes.toString('utf8')) as GridCollection, bbox);
  const listed = new Set(tiles.map((t) => t.name));
  const absent: string[] = [];
  for (let lat = Math.floor(bbox.south / 3) * 3; lat < bbox.north; lat += 3) {
    for (let lon = Math.floor(bbox.west / 3) * 3; lon < bbox.east; lon += 3) {
      const name = `N${String(lat).padStart(2, '0')}E${String(lon).padStart(3, '0')}`;
      if (!listed.has(name)) absent.push(name);
    }
  }

  const counts = newCounts(grid);
  const sources: Record<string, unknown>[] = [];
  for (const tile of tiles) {
    const url = tileUrl(tile.name);
    const file = await cached(url, join(cacheDir, tileFileName(tile.name)), values.refresh);
    const info = parseTiff(file.bytes);
    if (info.nodata !== 0)
      throw new Error(`${tile.name}: GDAL_NODATA is ${String(info.nodata)}, expected 0`);
    let blocks = 0;
    for (let index = 0; index < info.tileOffsets.length; index += 1) {
      if (!blockInGrid(info, index, grid)) continue;
      accumulateBlock(counts, grid, info, index, decodeBlock(file.bytes, info, index));
      blocks += 1;
    }
    const digest = sha256(file.bytes);
    sources.push({
      tile: tile.name,
      url,
      fetched_at: file.fetchedAt,
      bytes: file.bytes.length,
      sha256: digest,
      blocks_read: blocks,
    });
    console.log(`${tile.name}: ${String(blocks)} blocks, sha256 ${digest}`);
  }

  const product = quantize(counts, grid);
  const productFile = join(cacheDir, `worldcover-landcover-${PRODUCT_VERSION}.bin`);
  writeFileSync(productFile, product);
  const productSha = sha256(product);
  console.log(`product ${String(product.length)} bytes, sha256 ${productSha}`);

  // Summary: class shares over the whole box, and cells no tile covered.
  const planes = CLASSES.length;
  const totals = new Array<number>(planes).fill(0);
  let emptyCells = 0;
  for (let cell = 0; cell < grid.cols * grid.rows; cell += 1) {
    let pixels = 0;
    for (let p = 0; p < planes; p += 1) {
      const v = counts[cell * planes + p] ?? 0;
      totals[p] = (totals[p] ?? 0) + v;
      pixels += v;
    }
    if (pixels === 0) emptyCells += 1;
  }

  // The D5 S3 cross-check: WorldCover under each EFFIS perimeter, beside AGRIAREAS.
  const d5Path = join(REPO_ROOT, 'server', 'fixtures', 'effis-ba-candidates.json');
  const d5 = JSON.parse(readFileSync(d5Path, 'utf8')) as D5Asset;
  const s3 = d5.scenarios.find((s) => s.scenario === 'S3');
  if (!s3) throw new Error('no S3 scenario in the D5 candidates');
  const layers = new Map<string, ReturnType<typeof parseLayer>>();
  const reader = new PixelReader(cacheDir);
  const crosscheck: Record<string, unknown>[] = [];
  for (const candidate of s3.candidates) {
    for (const fire of candidate.fires) {
      let parsed = layers.get(fire.layer);
      if (!parsed) {
        const pinned = d5.sources.find((s) => s.layer === fire.layer)?.sha256;
        const bytes = readFileSync(join(values['effis-cache'], `${fire.layer}.geojson`));
        if (sha256(bytes) !== pinned) {
          throw new Error(`${fire.layer}: cached bytes differ from the sha256 D5 pinned`);
        }
        parsed = parseLayer(fire.layer, JSON.parse(bytes.toString('utf8')) as FeatureCollection);
        layers.set(fire.layer, parsed);
      }
      const perimeter = parsed.fires.find((f) => f.id === fire.effis_id);
      if (!perimeter) throw new Error(`${fire.layer}: no perimeter ${fire.effis_id}`);
      const fullCounts = polygonClassCounts(perimeter.rings, reader.read);
      const full = readCounts(fullCounts);
      const coarse = polygonProductWeights(product, grid, perimeter.rings);
      const grid005 = readCounts(coarse.weights);
      const pixels = fullCounts.reduce((a, b) => a + b, 0);
      crosscheck.push({
        rank: candidate.rank,
        effis_id: fire.effis_id,
        layer: fire.layer,
        commune: fire.commune,
        firedate: fire.firedate,
        area_ha: fire.area_ha,
        effis_agri_pct: fire.agri_pct,
        full_resolution: { pixels, ...full },
        product_0p005: { cells: coarse.cells, ...grid005 },
      });
      console.log(
        `S3 #${String(candidate.rank)} ${fire.effis_id}: EFFIS agri ${String(fire.agri_pct)} %, ` +
          `WorldCover cropland ${(full.cropland * 100).toFixed(1)} %, crop+grass ${(full.crop_or_grass * 100).toFixed(1)} %, ` +
          `majority ${full.majority}`,
      );
    }
  }

  const header = {
    format: FORMAT,
    version: PRODUCT_VERSION,
    task: 'TASKS D10 (land-cover half): WorldCover class shares over the polling box; DS-7',
    source:
      'ESA WorldCover 10 m 2021 v200 (doi:10.5281/zenodo.7254221), AWS Open Data bucket esa-worldcover',
    licence: 'CC BY 4.0',
    attribution: ATTRIBUTION,
    bbox,
    bbox_source: relative(REPO_ROOT, configPath),
    grid: {
      cell_deg: CELL_PIXELS / PIXELS_PER_DEGREE,
      cell_source_pixels: CELL_PIXELS,
      cols: grid.cols,
      rows: grid.rows,
      origin: 'north-west corner (west, north); row 0 is the northern edge',
      layout: `uint8, cell-major: byte[(row * cols + col) * ${String(planes)} + plane]`,
      planes: CLASSES.map((code) => `${String(code)} ${CLASS_NAMES[code]}`),
      scale: SCALE,
      quantisation:
        'largest remainder per cell, ties to the lower plane; the 12 shares of a cell sum to scale',
      empty_cell: 'a cell no published tile covers (open sea) is all no_data',
    },
    caveats: [
      'WorldCover 2021 is a single epoch: land converted since 2021 is not reflected.',
      'Cropland (40) is arable land; pasture and heterogeneous farmland are mostly grassland (30), so EFFIS AGRIAREAS (CORINE-based) and WorldCover cropland measure different things.',
      'Product shares are of 60×60 source pixels per cell; under a small perimeter they mix in the land around it.',
    ],
    grid_index: {
      url: GRID_URL,
      fetched_at: gridFile.fetchedAt,
      bytes: gridFile.bytes.length,
      sha256: sha256(gridFile.bytes),
    },
    absent_tiles: absent,
    product: {
      file: `data/worldcover-cache/worldcover-landcover-${PRODUCT_VERSION}.bin`,
      committed: false,
      bytes: product.length,
      sha256: productSha,
    },
    summary: {
      cells: grid.cols * grid.rows,
      empty_cells: emptyCells,
      pixels: totals.reduce((a, b) => a + b, 0),
      shares: readCounts(totals).fractions,
    },
  };
  const s3Head = {
    rule: 'D5 S3 candidates (AGRIAREAS >= 95 %); selection unchanged, read here only',
    d5_asset: relative(REPO_ROOT, d5Path),
    full_resolution: 'every 10 m pixel whose centre is inside an outer ring of the EFFIS perimeter',
    product_0p005: `the 0.005° product under the perimeter, each cell weighted by its share of a ${String(POLYGON_SUBSAMPLES)}×${String(POLYGON_SUBSAMPLES)} point lattice inside`,
    a6_threshold: 'cropland_ge_70 = at least 70 % on WorldCover 40 (A6 likely_agri_burn)',
  };

  const lines: string[] = ['{'];
  for (const [key, value] of Object.entries(header)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('  "tiles": [');
  lines.push(sources.map((s) => `    ${JSON.stringify(s)}`).join(',\n'));
  lines.push('  ],');
  lines.push(`  "s3_crosscheck": ${JSON.stringify(s3Head).slice(0, -1)},"candidates":[`);
  lines.push(crosscheck.map((c) => `    ${JSON.stringify(c)}`).join(',\n'));
  lines.push('  ]}');
  lines.push('}');
  writeFileSync(values.out, `${lines.join('\n')}\n`);
  console.log(`wrote ${values.out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
