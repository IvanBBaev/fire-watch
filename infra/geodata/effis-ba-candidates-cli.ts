#!/usr/bin/env node
/**
 * Pins golden-fixture fire candidates from the EFFIS burnt-area archive (TASKS D5):
 *
 *   server/fixtures/effis-ba-candidates.json — per scenario S1–S6, the real EFFIS
 *   perimeters that fit it, with EFFIS id, dates, area, place, and the sha256 of the
 *   archive file each was read from
 *
 *   pnpm run geodata:effis-ba [--cache <dir>] [--out <file>] [--refresh]
 *
 * Operator-run, never in CI. Each `modis.ba.poly.<YEAR>` layer is fetched once from the
 * EFFIS WFS and cached (`--cache`, reused unless `--refresh`) with a sidecar recording
 * when it was fetched, because the layers are large (2020 is ~70 MB) and EFFIS revises
 * perimeters: the cached bytes and their sha256 are the version the selection cites.
 * The Bulgaria outline is the committed oblast asset (`pnpm run geodata`).
 *
 * Exit codes: 0 ok, 1 a fetch or check failed.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  YEARS,
  buildCandidates,
  layerUrl,
  outlineFromRegions,
  parseLayer,
  serializeCandidates,
  type BaFire,
  type FeatureCollection,
  type RegionsAsset,
  type SourceFile,
} from './effis-ba-candidates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The compiled CLI runs from `infra/geodata/dist/`; the repo root is three levels up.
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const USER_AGENT = 'fire-watch-geodata/0.1 (+https://github.com/IvanBBaev/fire-watch)';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchLayer(url: string): Promise<Buffer> {
  // The EFFIS MapServer is slow to start a large response (over a minute for 2020).
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // MapServer reports a bad request as HTTP 200 with an XML exception report.
  if (!bytes.subarray(0, 64).toString('utf8').trimStart().startsWith('{')) {
    throw new Error(`${url}: not a GeoJSON response`);
  }
  return bytes;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string', default: join(REPO_ROOT, 'data', 'effis-ba-cache') },
      out: {
        type: 'string',
        default: join(REPO_ROOT, 'server', 'fixtures', 'effis-ba-candidates.json'),
      },
      refresh: { type: 'boolean', default: false },
    },
  });
  mkdirSync(values.cache, { recursive: true });

  const sources: SourceFile[] = [];
  const fires: BaFire[] = [];
  for (const year of YEARS) {
    const layer = `modis.ba.poly.${String(year)}`;
    const url = layerUrl(year);
    const file = join(values.cache, `${layer}.geojson`);
    const meta = `${file}.fetched`;
    let bytes: Buffer;
    if (existsSync(file) && !values.refresh) {
      bytes = readFileSync(file);
    } else {
      console.log(`fetching ${layer} …`);
      bytes = await fetchLayer(url);
      writeFileSync(file, bytes);
      // eslint-disable-next-line no-restricted-syntax -- operator CLI recording the real fetch time
      writeFileSync(meta, `${new Date().toISOString()}\n`);
    }
    // A file cached before the sidecar existed is dated by its write time.
    const fetchedAt = existsSync(meta)
      ? readFileSync(meta, 'utf8').trim()
      : statSync(file).mtime.toISOString();
    const parsed = parseLayer(layer, JSON.parse(bytes.toString('utf8')) as FeatureCollection);
    fires.push(...parsed.fires);
    sources.push({
      layer,
      url,
      fetched_at: fetchedAt,
      bytes: bytes.length,
      sha256: sha256(bytes),
      features: parsed.fires.length + parsed.dropped,
      dropped: parsed.dropped,
    });
    console.log(`${layer}: ${String(parsed.fires.length)} perimeters, sha256 ${sha256(bytes)}`);
  }

  const outlinePath = join(REPO_ROOT, 'web', 'src', 'assets', 'geodata', 'oblasts.json');
  const regions = JSON.parse(readFileSync(outlinePath, 'utf8')) as RegionsAsset;
  const outline = outlineFromRegions(regions);
  const outlineSource = `web/src/assets/geodata/oblasts.json (${regions.source ?? 'unknown source'})`;

  const asset = buildCandidates(sources, fires, outline, outlineSource);
  writeFileSync(values.out, serializeCandidates(asset));
  for (const s of asset.scenarios) {
    console.log(`${s.scenario}: ${s.status}, ${String(s.candidates.length)} candidates`);
  }
  console.log(`wrote ${values.out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
