#!/usr/bin/env node
/**
 * Builds the static hot-source mask (TASKS F16):
 *
 *   web/src/assets/geodata/static-sources.json — solar parks, thermal plants, heavy
 *   industry and flares in the served box, from OpenStreetMap (ODbL 1.0)
 *
 *   pnpm run geodata:static-sources [--cache <dir>] [--out <dir>] [--endpoint <url>] [--refresh]
 *
 * Operator-run, never in CI, refreshed quarterly (11-data-science §6.2). The Overpass
 * response is cached (`--cache`, reused unless `--refresh`), because Overpass is a shared
 * volunteer service and the transform is the part worth re-running. The query's and the
 * response's SHA-256 go into the asset and into docs/data/DATASETS.md (DS-5), so the
 * committed file can always be traced to the exact OSM snapshot it was cut from.
 *
 * Exit codes: 0 ok, 1 a fetch or check failed, 2 usage error.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import {
  OVERPASS_QUERY,
  buildStaticSources,
  serializeStaticSources,
  type OverpassResponse,
} from './static-sources.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The compiled CLI runs from `infra/geodata/dist/`; the repo root is three levels up.
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
// Overpass answers 406 to a request without a User-Agent.
const USER_AGENT = 'fire-watch-geodata/0.1 (+https://github.com/IvanBBaev/fire-watch)';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchOverpass(endpoint: string): Promise<Buffer> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: OVERPASS_QUERY }).toString(),
  });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${String(response.status)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // Overpass reports a timeout or overload as HTTP 200 with an HTML or `remark` body.
  const head = bytes.subarray(0, 64).toString('utf8').trimStart();
  if (!head.startsWith('{')) throw new Error(`${endpoint}: not a JSON response`);
  return bytes;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string', default: join(REPO_ROOT, 'data', 'geodata-cache') },
      out: { type: 'string', default: join(REPO_ROOT, 'web', 'src', 'assets', 'geodata') },
      endpoint: { type: 'string', default: DEFAULT_ENDPOINT },
      refresh: { type: 'boolean', default: false },
    },
  });
  mkdirSync(values.cache, { recursive: true });
  mkdirSync(values.out, { recursive: true });

  const cacheFile = join(values.cache, 'overpass-static-sources.json');
  let bytes: Buffer;
  if (existsSync(cacheFile) && !values.refresh) {
    bytes = readFileSync(cacheFile);
  } else {
    bytes = await fetchOverpass(values.endpoint);
    writeFileSync(cacheFile, bytes);
  }
  const response = JSON.parse(bytes.toString('utf8')) as OverpassResponse & {
    remark?: string;
  };
  if (response.remark !== undefined) {
    console.error(`Overpass remark (the response may be truncated): ${response.remark}`);
    process.exitCode = 1;
    return;
  }

  const querySha256 = sha256(OVERPASS_QUERY);
  const responseSha256 = sha256(bytes);
  const asset = buildStaticSources(response, {
    source: `OpenStreetMap via Overpass API (${values.endpoint})`,
    querySha256,
    responseSha256,
  });
  const text = serializeStaticSources(asset);
  writeFileSync(join(values.out, 'static-sources.json'), text);
  const gz = gzipSync(text, { level: 9 }).length;
  console.log(`static-sources.json: ${Buffer.byteLength(text)} B raw, ${gz} B gzip -9`);
  console.log(`version ${asset.version}, osm_base ${asset.osm_base}`);
  console.log(`query sha256 ${querySha256}`);
  console.log(`response sha256 ${responseSha256}`);
  console.log(`counts ${JSON.stringify(asset.counts)}, dropped ${JSON.stringify(asset.dropped)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
