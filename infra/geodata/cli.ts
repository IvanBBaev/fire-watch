#!/usr/bin/env node
/**
 * Builds the two lazy-loaded geodata assets of the web app's filter bar (Track F):
 *
 *   web/src/assets/geodata/oblasts.json      — 28 oblast polygons (Natural Earth, PD)
 *   web/src/assets/geodata/settlements.json  — settlement gazetteer (GeoNames, CC BY 4.0)
 *
 *   pnpm run geodata [--cache <dir>] [--out <dir>]
 *
 * Operator-run, never in CI: it downloads the sources (into `--cache`, reused when
 * present) and prints the SHA-256 of each, which the generated files also record. The
 * Natural Earth URL is pinned to a release tag and its hash is checked; the GeoNames
 * dumps are republished daily, so their hash is recorded, not checked — re-running on
 * another day is expected to produce a small diff, which is the point of a refresh.
 *
 * Exit codes: 0 ok, 1 a check failed, 2 usage error.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import { buildGazetteer, buildRegions } from './transform.js';
import { readZipMember } from './zip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The compiled CLI runs from `infra/geodata/dist/`; the repo root is three levels up.
const REPO_ROOT = resolve(HERE, '..', '..', '..');

export const NATURAL_EARTH = {
  url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson',
  sha256: '22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5',
} as const;

export const GEONAMES = {
  places: 'https://download.geonames.org/export/dump/BG.zip',
  alternateNames: 'https://download.geonames.org/export/dump/alternatenames/BG.zip',
} as const;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchCached(url: string, cacheFile: string): Promise<Buffer> {
  if (existsSync(cacheFile)) return readFileSync(cacheFile);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(cacheFile, bytes);
  return bytes;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string', default: join(REPO_ROOT, 'data', 'geodata-cache') },
      out: { type: 'string', default: join(REPO_ROOT, 'web', 'src', 'assets', 'geodata') },
    },
  });
  const cache = values.cache;
  const out = values.out;
  mkdirSync(cache, { recursive: true });
  mkdirSync(out, { recursive: true });

  const ne = await fetchCached(NATURAL_EARTH.url, join(cache, 'ne_10m_admin_1.geojson'));
  const neHash = sha256(ne);
  if (neHash !== NATURAL_EARTH.sha256) {
    console.error(`Natural Earth hash mismatch: ${neHash} (pinned ${NATURAL_EARTH.sha256})`);
    process.exitCode = 1;
    return;
  }
  const placesZip = await fetchCached(GEONAMES.places, join(cache, 'geonames-BG.zip'));
  const altZip = await fetchCached(GEONAMES.alternateNames, join(cache, 'geonames-alt-BG.zip'));

  const regions = buildRegions(
    JSON.parse(ne.toString('utf8')) as Parameters<typeof buildRegions>[0],
    `Natural Earth 10m admin-1 v5.1.2 (public domain) sha256:${neHash}`,
  );
  const gazetteer = buildGazetteer(
    readZipMember(placesZip, 'BG.txt').toString('utf8'),
    readZipMember(altZip, 'BG.txt').toString('utf8'),
    regions,
    `GeoNames BG.zip sha256:${sha256(placesZip)} + alternatenames/BG.zip sha256:${sha256(altZip)}` +
      ' (CC BY 4.0, https://www.geonames.org/)',
  );

  for (const [file, asset] of [
    ['oblasts.json', regions],
    ['settlements.json', gazetteer],
  ] as const) {
    const text = `${JSON.stringify(asset)}\n`;
    writeFileSync(join(out, file), text);
    const bytes = Buffer.byteLength(text);
    const gz = gzipSync(text, { level: 9 }).length;
    console.log(`${file}: ${bytes} B raw, ${gz} B gzip -9`);
  }
  console.log(`settlements: ${gazetteer.places.length}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
