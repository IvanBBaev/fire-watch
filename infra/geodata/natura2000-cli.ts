#!/usr/bin/env node
/**
 * Builds the Natura 2000 protected-site asset (V2-F1):
 *
 *   web/src/assets/geodata/natura2000.json — every SPA and SCI meeting the served box,
 *   from the EEA Natura 2000 map service (CC BY 4.0)
 *
 *   pnpm run geodata:natura2000 [--cache <dir>] [--out <dir>] [--refresh]
 *
 * Operator-run, never in CI, refreshed when the EEA publishes a new yearly release. The
 * service's pages (100 sites each, ordered by site code) are cached under `--cache` and
 * reused unless `--refresh`, because the raw geometry is ~200 MB and the transform is the
 * part worth re-running (`data/` is git-ignored). The release, the newest site `RELEASE_DATE` and a SHA-256 over
 * the pages go into the asset and into docs/data/DATASETS.md, so the committed file can be
 * traced to the exact service answer it was cut from.
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
  PAGE_SIZE,
  SERVICE_URL,
  buildNatura2000,
  pageUrl,
  serializeNatura2000,
  type SiteFeature,
} from './natura2000.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The compiled CLI runs from `infra/geodata/dist/`; the repo root is three levels up.
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const USER_AGENT = 'fire-watch-geodata/0.1 (+https://github.com/IvanBBaev/fire-watch)';
/** A guard against a paging bug looping forever; the box holds well under a thousand sites. */
const MAX_PAGES = 50;

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The release year the service states in its description ("…dataset: 2024."). */
async function serviceRelease(): Promise<string> {
  const body = JSON.parse((await fetchBytes(`${SERVICE_URL}?f=json`)).toString('utf8')) as {
    description?: string;
  };
  const match = /dataset:\s*(\d{4})/.exec(body.description ?? '');
  if (match?.[1] === undefined) throw new Error('the service description names no release');
  return match[1];
}

interface Page {
  readonly features: readonly SiteFeature[];
  readonly exceededTransferLimit?: boolean;
  readonly error?: unknown;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string', default: join(REPO_ROOT, 'data', 'natura2000-cache') },
      out: { type: 'string', default: join(REPO_ROOT, 'web', 'src', 'assets', 'geodata') },
      refresh: { type: 'boolean', default: false },
    },
  });
  mkdirSync(values.cache, { recursive: true });
  mkdirSync(values.out, { recursive: true });

  const releaseFile = join(values.cache, 'natura2000-release.txt');
  let release: string;
  if (existsSync(releaseFile) && !values.refresh) {
    release = readFileSync(releaseFile, 'utf8').trim();
  } else {
    release = await serviceRelease();
    writeFileSync(releaseFile, `${release}\n`);
  }

  const hash = createHash('sha256');
  const features: SiteFeature[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const cacheFile = join(values.cache, `natura2000-page-${String(offset)}.json`);
    let bytes: Buffer;
    if (existsSync(cacheFile) && !values.refresh) {
      bytes = readFileSync(cacheFile);
    } else {
      bytes = await fetchBytes(pageUrl(offset));
      writeFileSync(cacheFile, bytes);
    }
    hash.update(bytes);
    const body = JSON.parse(bytes.toString('utf8')) as Page;
    if (body.error !== undefined) throw new Error(`page ${String(offset)}: service error`);
    features.push(...body.features);
    if (body.features.length < PAGE_SIZE || body.exceededTransferLimit !== true) break;
    if (page === MAX_PAGES - 1) throw new Error(`more than ${String(MAX_PAGES)} pages`);
  }

  const pagesSha256 = hash.digest('hex');
  const asset = buildNatura2000(features, {
    source: `EEA Natura 2000 map service (${SERVICE_URL})`,
    release,
    pagesSha256,
  });
  const text = serializeNatura2000(asset);
  writeFileSync(join(values.out, 'natura2000.json'), text);
  const gz = gzipSync(text, { level: 9 }).length;
  console.log(`natura2000.json: ${Buffer.byteLength(text)} B raw, ${gz} B gzip -9`);
  console.log(`version ${asset.version}, newest site release ${String(asset.release_date)}`);
  console.log(`pages sha256 ${pagesSha256}`);
  console.log(`counts ${JSON.stringify(asset.counts)}, dropped ${JSON.stringify(asset.dropped)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
